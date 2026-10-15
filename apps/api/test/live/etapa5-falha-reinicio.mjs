// Roteiro ao vivo. `fail`: suba a API com POC_BOT_ACTION=customer.requests.fail OP_SIMULATED_MS=1500.
//   `restart`: OP_SIMULATED_MS=6000; o script reinicia o container da API no meio da operação.
// Uso: node etapa5-falha-reinicio.mjs fail|restart
const API = 'http://localhost:3001';
const mode = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, path, body, token) => { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
const waitFor = async (fn, ms, step = 400) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; };
const state = async (s) => (await j('GET', '/public/attendance', null, s)).body;
const texts = (s) => s.messages.map((m) => `${m.sender}:${m.content.text ?? m.content.type}`);
const start = await j('POST', '/public/attendances', { tenant: 'poc', application: 'chat' });
const session = start.body.session;
console.log('protocolo', start.body.attendance.protocolNumber);
if (mode === 'restart') {
  await waitFor(async () => (await state(session)).chat.pendingOperation, 8000, 150);
  console.log('operação pendente; reiniciando a API agora…');
  const { execSync } = await import('node:child_process');
  execSync('docker kill chat-api-1 && docker start chat-api-1', { stdio: 'ignore' });
}
const done = await waitFor(async () => { const s = await state(session); return !s.chat.pendingOperation && s.messages.length >= 2 ? s : null; }, 90000, 700);
const s = done ?? (await state(session));
console.log(texts(s), s.chat);
const errCount = texts(s).filter((t) => t.includes('Não consegui consultar')).length;
const okCount = texts(s).filter((t) => t.includes('2 solicitações')).length;
if (mode === 'fail') console.log(errCount === 1 ? 'PASS falha: exatamente 1 mensagem de erro, indicador removido' : `FAIL erros=${errCount}`);
if (mode === 'restart') console.log(okCount === 1 ? 'PASS reinício: resultado entregue uma única vez após reiniciar' : `FAIL resultados=${okCount}`);
