/* eslint-disable @typescript-eslint/require-await -- fakes implementam contratos assíncronos */
import { createHarness } from '@modules/shared/database/testHarness';
import {
  PermanentOutboxError,
  RetryLater,
} from '@modules/outbox/outbox.errors';

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe('outbox (PostgreSQL real)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.destroy());
  afterEach(() => h.db.query('DELETE FROM outbox_events'));

  const status = async (type: string) =>
    (
      await h.db.query<{
        status: string;
        attempts: number;
        last_error: string | null;
      }>(
        'SELECT status, attempts, last_error FROM outbox_events WHERE type = $1',
        [type],
      )
    ).rows[0];

  it('deduplica por chave', async () => {
    for (let i = 0; i < 3; i++)
      await h.outbox.enqueue(h.db, { type: 'x', dedupeKey: 'k1' });
    const { rows } = await h.db.query('SELECT 1 FROM outbox_events');
    expect(rows).toHaveLength(1);
  });

  it('reivindicações concorrentes nunca entregam o mesmo evento duas vezes (SKIP LOCKED)', async () => {
    for (let i = 0; i < 60; i++) await h.outbox.enqueue(h.db, { type: 'bulk' });
    const batches = await Promise.all(
      Array.from({ length: 6 }, () => h.outbox.claim(15, 30_000)),
    );
    const ids = batches.flat().map((e) => e.id);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  it('serializa por atendimento: um evento por vez, na ordem', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    await h.db.query('DELETE FROM outbox_events'); // descarta attendance.created
    for (const type of ['first', 'second', 'third'])
      await h.outbox.enqueue(h.db, {
        tenantId: tenant.id,
        attendanceId: attendance.id,
        type,
      });

    const first = await h.outbox.claim(10, 30_000);
    expect(first.map((e) => e.type)).toEqual(['first']);
    // Enquanto o primeiro está em processamento, nenhum outro do mesmo atendimento sai.
    expect(await h.outbox.claim(10, 30_000)).toHaveLength(0);
    await h.outbox.complete(first[0]);
    expect((await h.outbox.claim(10, 30_000)).map((e) => e.type)).toEqual([
      'second',
    ]);
  });

  it('réplicas concorrentes nunca processam o mesmo atendimento ao mesmo tempo', async () => {
    const { tenant, app } = await h.newTenant();
    const attendances: { id: string }[] = [];
    for (let i = 0; i < 8; i++)
      attendances.push((await h.open(tenant.id, app.id)).attendance);
    await h.db.query('DELETE FROM outbox_events');
    for (const a of attendances)
      for (const type of ['e1', 'e2', 'e3'])
        await h.outbox.enqueue(h.db, {
          tenantId: tenant.id,
          attendanceId: a.id,
          type,
        });
    // Várias rodadas de claims simultâneos, sem concluir nada: cada atendimento só pode
    // ter um evento em processamento (e deve ser o mais antigo).
    for (let round = 0; round < 5; round++)
      await Promise.all(
        Array.from({ length: 6 }, () => h.outbox.claim(10, 30_000)),
      );
    const { rows } = await h.db.query<{
      attendance_id: string;
      n: string;
      types: string[];
    }>(
      `SELECT attendance_id, count(*) AS n, array_agg(type) AS types
         FROM outbox_events WHERE status = 'processing' GROUP BY attendance_id`,
    );
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(Number(row.n)).toBe(1);
      expect(row.types).toEqual(['e1']);
    }
  });

  it('lease vencido devolve o evento (worker caiu) e conta a tentativa', async () => {
    await h.outbox.enqueue(h.db, { type: 'crash' });
    const [a] = await h.outbox.claim(1, 1); // lease de 1 ms
    await new Promise((r) => setTimeout(r, 30));
    const [b] = await h.outbox.claim(1, 30_000);
    expect(b.id).toBe(a.id);
    expect(b.attempts).toBe(2);
    // O dono antigo perdeu a posse: completar com a tentativa antiga não tem efeito.
    await h.outbox.complete(a);
    expect((await status('crash')).status).toBe('processing');
    await h.outbox.complete(b);
    expect((await status('crash')).status).toBe('done');
  });

  it('esgota as tentativas e vai para dead, com backoff entre elas', async () => {
    await h.outbox.enqueue(h.db, { type: 'flaky', maxAttempts: 2 });
    const [a] = await h.outbox.claim(1, 30_000);
    await h.outbox.fail(a, 'erro 1');
    expect(await h.outbox.claim(1, 30_000)).toHaveLength(0); // ainda no backoff
    await h.makeDue();
    const [b] = await h.outbox.claim(1, 30_000);
    await h.outbox.fail(b, 'erro 2');
    expect(await status('flaky')).toMatchObject({
      status: 'dead',
      attempts: 2,
      last_error: 'erro 2',
    });
  });

  it('worker: sucesso, retry com RetryLater, erro permanente e tipo sem handler', async () => {
    const calls: string[] = [];
    let flaky = 0;
    h.dispatcher.register('w.ok', async () => void calls.push('ok'));
    h.dispatcher.register('w.later', async () => {
      if (flaky++ < 1) throw new RetryLater('ainda não', 10);
      calls.push('later');
    });
    h.dispatcher.register('w.perm', async () => {
      throw new PermanentOutboxError('nunca vai dar');
    });
    for (const type of ['w.ok', 'w.later', 'w.perm', 'w.unknown'])
      await h.outbox.enqueue(h.db, { type });
    await h.outboxWorker.runOnce();
    expect((await status('w.ok')).status).toBe('done');
    expect((await status('w.later')).status).toBe('pending');
    expect((await status('w.perm')).status).toBe('dead');
    expect((await status('w.unknown')).status).toBe('dead');
    await new Promise((r) => setTimeout(r, 30));
    await h.outboxWorker.runOnce();
    expect((await status('w.later')).status).toBe('done');
    expect(calls).toEqual(['ok', 'later']);
  });

  it('mensagem e sinal realtime saem juntos; Centrifugo fora do ar não perde o sinal', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    await h.db.query(
      "DELETE FROM outbox_events WHERE type = 'attendance.created'",
    );
    h.published.length = 0;
    await h.messages.append({
      tenantId: tenant.id,
      attendanceId: attendance.id,
      sender: 'bot',
      content: { type: 'text', text: 'oi' },
    });
    // Persistida, mas ainda não publicada: publicação só depois da persistência, pelo worker.
    expect(h.published).toHaveLength(0);
    h.realtime.failures = 1;
    await h.outboxWorker.runOnce();
    expect(h.published).toHaveLength(0);
    await h.makeDue();
    await h.outboxWorker.runOnce();
    expect(h.published).toEqual([
      { attendanceId: attendance.id, event: 'message.created' },
    ]);
  });

  it('retenção remove só eventos concluídos antigos (dead e recentes ficam)', async () => {
    for (const type of ['old.done', 'new.done', 'old.dead'])
      await h.outbox.enqueue(h.db, { type });
    await h.db.query(
      `UPDATE outbox_events SET status = 'done', processed_at = now() - interval '10 days' WHERE type = 'old.done';
       UPDATE outbox_events SET status = 'done', processed_at = now() WHERE type = 'new.done';
       UPDATE outbox_events SET status = 'dead', processed_at = now() - interval '10 days' WHERE type = 'old.dead'`,
    );
    expect(await h.outbox.purgeDone(7)).toBe(1);
    const { rows } = await h.db.query<{ type: string }>(
      'SELECT type FROM outbox_events ORDER BY type',
    );
    expect(rows.map((r) => r.type)).toEqual(['new.done', 'old.dead']);
  });

  it('rollback da transação não deixa evento órfão', async () => {
    await expect(
      h.db.tx(async (q) => {
        await h.outbox.enqueue(q, { type: 'orfao' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    expect(
      (await h.db.query("SELECT 1 FROM outbox_events WHERE type = 'orfao'"))
        .rows,
    ).toHaveLength(0);
  });
});
