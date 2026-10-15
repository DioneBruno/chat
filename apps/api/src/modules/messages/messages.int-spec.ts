import { createHarness } from '../../database/test-harness';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
beforeAll(async () => void (h = await createHarness()));
afterAll(() => h.destroy());

const text = (t: string) => ({ type: 'text' as const, text: t });

describe('mensagens', () => {
  it('persiste em ordem e sincroniza por cursor', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const ids = { tenantId: tenant.id, attendanceId: attendance.id };
    const a = await h.messages.append({
      ...ids,
      sender: 'bot',
      content: text('olá'),
    });
    await h.messages.append({
      ...ids,
      sender: 'consumer',
      content: text('oi'),
    });
    await h.messages.append({
      ...ids,
      sender: 'agent',
      content: { type: 'options', options: [{ id: '1', label: 'Sim' }] },
    });
    const all = await h.messages.list(ids);
    expect(all.map((m) => m.sender)).toEqual(['bot', 'consumer', 'agent']);
    expect(
      await h.messages.list({ ...ids, afterSeq: a.message.seq }),
    ).toHaveLength(2);
  });

  it('idempotência: reenvios e corridas não duplicam', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const ids = {
      tenantId: tenant.id,
      attendanceId: attendance.id,
      sender: 'consumer' as const,
      content: text('uma vez'),
      idempotencyKey: 'k1',
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.messages.append(ids)),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(await h.messages.list(ids)).toHaveLength(1);
  });

  it('mesma chave em atendimentos diferentes não colide', async () => {
    const { tenant, app } = await h.newTenant();
    const a = await h.open(tenant.id, app.id);
    const b = await h.open(tenant.id, app.id);
    const send = (id: string) =>
      h.messages.append({
        tenantId: tenant.id,
        attendanceId: id,
        sender: 'bot',
        content: text('x'),
        idempotencyKey: 'same',
      });
    expect((await send(a.attendance.id)).duplicate).toBe(false);
    expect((await send(b.attendance.id)).duplicate).toBe(false);
  });

  it('protocolo encerrado é somente leitura (serviço e banco), mas reenvio idempotente devolve a original', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const ids = { tenantId: tenant.id, attendanceId: attendance.id };
    await h.messages.append({
      ...ids,
      sender: 'consumer',
      content: text('antes'),
      idempotencyKey: 'a',
    });
    await h.attendances.close({
      tenantId: tenant.id,
      id: attendance.id,
      reason: 'x',
      by: 'system',
    });
    await expect(
      h.messages.append({
        ...ids,
        sender: 'consumer',
        content: text('depois'),
      }),
    ).rejects.toThrow(/encerrado/);
    expect(
      (
        await h.messages.append({
          ...ids,
          sender: 'consumer',
          content: text('antes'),
          idempotencyKey: 'a',
        })
      ).duplicate,
    ).toBe(true);
    await expect(
      h.db.query(
        `INSERT INTO messages (tenant_id, attendance_id, conversation_id, sender_type, content)
                  SELECT tenant_id, attendance_id, id, 'bot', '{"type":"text","text":"x"}' FROM conversations WHERE attendance_id = $1`,
        [attendance.id],
      ),
    ).rejects.toThrow(/not open/);
    expect(await h.messages.list(ids)).toHaveLength(1);
  });

  it('mensagens são imutáveis', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    await h.messages.append({
      tenantId: tenant.id,
      attendanceId: attendance.id,
      sender: 'bot',
      content: text('x'),
    });
    await expect(
      h.db.query(
        'UPDATE messages SET content = \'{"type":"text","text":"y"}\'',
      ),
    ).rejects.toThrow(/immutable/);
    await expect(h.db.query('DELETE FROM messages')).rejects.toThrow(
      /immutable/,
    );
  });

  it('valida o conteúdo', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const ids = {
      tenantId: tenant.id,
      attendanceId: attendance.id,
      sender: 'consumer' as const,
    };
    await expect(
      h.messages.append({ ...ids, content: { type: 'text', text: '  ' } }),
    ).rejects.toThrow();
    await expect(
      h.messages.append({ ...ids, content: { type: 'html', text: 'x' } }),
    ).rejects.toThrow();
    await expect(
      h.messages.append({
        ...ids,
        content: { type: 'text', text: 'x'.repeat(4001) },
      }),
    ).rejects.toThrow();
  });

  it('resposta do consumidor renova o prazo geral e cancela o de pós-atendimento', async () => {
    const { tenant, app } = await h.newTenant({ generalInactivityMinutes: 30 });
    const { attendance } = await h.open(tenant.id, app.id);
    const ids = {
      tenantId: tenant.id,
      attendanceId: attendance.id,
      sender: 'consumer' as const,
    };
    await h.db.query(
      "UPDATE attendances SET inactivity_deadline_at = now() + interval '1 minute' WHERE id = $1",
      [attendance.id],
    );
    await h.messages.append({ ...ids, content: text('oi') });
    const renewed = (await h.attendances.get(tenant.id, attendance.id))
      .inactivityDeadlineAt!;
    expect(renewed.getTime() - Date.now()).toBeGreaterThan(28 * 60_000);
    await h.db.query(
      "UPDATE attendances SET phase = 'post_service', inactivity_deadline_at = now() + interval '60 minutes' WHERE id = $1",
      [attendance.id],
    );
    await h.messages.append({ ...ids, content: text('sim') });
    expect(
      (await h.attendances.get(tenant.id, attendance.id)).inactivityDeadlineAt,
    ).toBeNull();
  });
});
