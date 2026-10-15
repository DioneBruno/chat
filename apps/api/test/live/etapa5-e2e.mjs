// Roteiro ao vivo (não roda no CI): precisa de `docker compose up -d` com Typebot, Chatwoot e Centrifugo.
// Uso: TYPEBOT_ID=poc-async docker compose up -d api && node etapa5-e2e.mjs async
//      TYPEBOT_ID=poc-handoff docker compose up -d api && node etapa5-e2e.mjs handoff
// E2E ao vivo da etapa 5 contra Typebot + Chatwoot + Centrifugo reais.
// Uso: node e2e5.mjs async | handoff
const API = 'http://localhost:3001';
const CHATWOOT = 'http://localhost:3000/api/v1/accounts/1';
const CW_TOKEN = process.env.CHATWOOT_API_TOKEN ?? 'f4Yid8AzhGiq9v1oNoUZu25J';
const mode = process.argv[2] ?? 'async';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, bad = 0;
const check = (name, cond, extra = '') => { (cond ? ok++ : bad++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${cond ? '' : extra}`); };

const j = async (method, path, body, token) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
};
const cw = async (method, path, body) => {
  const r = await fetch(CHATWOOT + path, { method, headers: { 'content-type': 'application/json', api_access_token: CW_TOKEN }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const waitFor = async (fn, ms = 30000, step = 400) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

// --- Realtime: assina o canal privado e coleta os sinais
async function subscribe(session) {
  const t = (await j('GET', '/public/attendance/realtime', null, session)).body;
  const events = [];
  const ws = new WebSocket('ws://localhost:8000/connection/websocket', 'centrifuge-json');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => { for (const line of String(m.data).split('\n')) { if (!line.trim()) continue; const d = JSON.parse(line); if (d.id === undefined && Object.keys(d).length === 0) ws.send('{}'); const pub = d.push?.pub?.data ?? d.pub?.data; if (pub?.event) events.push(pub.event); } };
  ws.send(JSON.stringify({ id: 1, connect: { token: t.connectionToken, name: 'e2e' } }));
  await sleep(300);
  ws.send(JSON.stringify({ id: 2, subscribe: { channel: t.channel, token: t.subscriptionToken } }));
  await sleep(300);
  return { events, ws };
}

const state = async (session) => (await j('GET', '/public/attendance', null, session)).body;
const lastTexts = (s) => s.messages.map((m) => `${m.sender}:${m.content.text ?? m.content.type}`);
const say = (session, text, optionId) => j('POST', '/public/attendance/messages', { text, optionId, idempotencyKey: crypto.randomUUID() }, session);

const start = await j('POST', '/public/attendances', { tenant: 'poc', application: 'chat' });
check('POST /public/attendances cria protocolo e sessão', start.status === 201 && /^\d{4}-\d{6}$/.test(start.body.attendance.protocolNumber), JSON.stringify(start.body));
const session = start.body.session;
console.log('protocolo', start.body.attendance.protocolNumber);
const rt = await subscribe(session);

const first = await waitFor(async () => { const s = await state(session); return s.messages.length ? s : null; });
check('Typebot iniciou pelo worker (outbox) e mensagens foram persistidas', !!first, 'sem mensagens');
console.log(lastTexts(first));

if (mode === 'async') {
  const waiting = await waitFor(async () => { const s = await state(session); return s.chat.pendingOperation ? s : null; }, 8000, 200);
  check('operação pendente visível na API (reconexão recupera o indicador)', !!waiting);
  const t0 = Date.now();
  const done = await waitFor(async () => { const s = await state(session); return !s.chat.pendingOperation && lastTexts(s).some((t) => t.includes('2 solicitações')) ? s : null; }, 30000, 300);
  check('resultado chegou sem nova mensagem do consumidor', !!done, JSON.stringify(lastTexts(await state(session))));
  console.log(`resultado após ${Date.now() - t0} ms`, lastTexts(done ?? first));
  await sleep(500);
  check('Centrifugo entregou completed + message.created (sinais após a assinatura)', ['bot.operation.completed', 'message.created'].every((e) => rt.events.includes(e)), JSON.stringify(rt.events));
  // reload no meio: nova sessão HTTP lê o mesmo histórico
  const again = await state(session);
  check('recarregar não perde o histórico', again.messages.length === done.messages.length);
} else {
  // handoff: escolhe "Falar com atendente"
  const opts = first.messages.find((m) => m.content.type === 'options');
  const human = opts?.content.options.find((o) => /atendente/i.test(o.label));
  check('menu com a opção de atendente', !!human, JSON.stringify(opts));
  await say(session, 'Falar com atendente', human?.id);
  const inHuman = await waitFor(async () => { const s = await state(session); return s.attendance.phase === 'human' ? s : null; }, 30000, 400);
  check('fase human após handoff (Chatwoot conversa criada)', !!inHuman, JSON.stringify((await state(session)).attendance));
  await say(session, 'preciso de ajuda real');
  await sleep(500);
  const convs = (await cw('GET', '/conversations?status=open')).data?.payload ?? [];
  const mine = convs.find((c) => c.custom_attributes?.attendance_id === start.body.attendance.id);
  check('conversa do Chatwoot vinculada ao protocolo', !!mine);
  let msgs = [];
  await waitFor(async () => { msgs = (await cw('GET', `/conversations/${mine.id}/messages`)).payload ?? []; return msgs.some((m) => !m.private && m.content === 'preciso de ajuda real'); }, 8000, 300);
  check('contexto (nota privada) e mensagem do consumidor chegaram', msgs.some((m) => m.private && /Contexto/.test(m.content)) && msgs.some((m) => !m.private && m.content === 'preciso de ajuda real'), JSON.stringify(msgs.map((m) => [m.message_type, m.private, m.content])));
  await cw('POST', `/conversations/${mine.id}/messages`, { content: 'Olá, sou a Ana', message_type: 'outgoing' });
  const agent = await waitFor(async () => { const s = await state(session); return lastTexts(s).includes('agent:Olá, sou a Ana') ? s : null; }, 15000, 400);
  check('resposta do atendente chegou ao chat via webhook', !!agent);
  await cw('POST', `/conversations/${mine.id}/toggle_status`, { status: 'resolved' });
  const post = await waitFor(async () => { const s = await state(session); return s.attendance.phase === 'post_service' ? s : null; }, 30000, 400);
  check('resolver no Chatwoot -> NOVA sessão Typebot de pós-atendimento (protocolo segue aberto)', !!post && post.attendance.status === 'open', JSON.stringify((await state(session)).attendance));
  console.log(lastTexts(post ?? first).slice(-3));
  const no = post?.messages.filter((m) => m.content.type === 'options').at(-1)?.content.options.find((o) => /n[ãa]o/i.test(o.label));
  if (no) {
    await say(session, no.label, no.id);
    const closed = await waitFor(async () => { const s = await state(session); return s.attendance.status !== 'open' ? s : null; }, 20000, 400);
    check('"Não" -> bot encerra o protocolo', !!closed, JSON.stringify((await state(session)).attendance));
    console.log(closed?.attendance);
    const r = await say(session, 'oi?');
    check('protocolo encerrado é somente leitura (409)', r.status === 409, String(r.status));
  } else check('opção "Não" no pós-atendimento', false, JSON.stringify(post?.messages.at(-1)));
}
rt.ws.close();
console.log(`\n${ok} ok, ${bad} falhas`);
process.exit(bad ? 1 : 0);
