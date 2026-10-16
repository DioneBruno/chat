import { createHarness } from '@modules/shared/database/testHarness';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
beforeAll(async () => void (h = await createHarness()));
afterAll(() => h.destroy());

describe('protocolo ANO-SEQUENCIAL', () => {
  it('gera sequenciais únicos e sem buracos sob concorrência', async () => {
    const { tenant, app } = await h.newTenant();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => h.open(tenant.id, app.id)),
    );
    const numbers = results.map((r) => r.attendance.protocolNumber).sort();
    const year = new Date().getFullYear();
    expect(new Set(numbers).size).toBe(40);
    expect(numbers[0]).toBe(`${year}-000001`);
    expect(numbers[39]).toBe(`${year}-000040`);
  });

  it('numera por tenant (isolado) e reinicia a cada ano', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    h.attendances.clock = () => new Date('2026-12-31T12:00:00Z');
    const a1 = await h.open(a.tenant.id, a.app.id);
    const b1 = await h.open(b.tenant.id, b.app.id);
    h.attendances.clock = () => new Date('2027-01-02T12:00:00Z');
    const a2 = await h.open(a.tenant.id, a.app.id);
    h.attendances.clock = () => new Date();
    expect(a1.attendance.protocolNumber).toBe('2026-000001');
    expect(b1.attendance.protocolNumber).toBe('2026-000001');
    expect(a2.attendance.protocolNumber).toBe('2027-000001');
  });
});

describe('atendimento aberto do consumidor', () => {
  it('reutiliza o mesmo protocolo, mesmo com aberturas concorrentes', async () => {
    const { tenant, app } = await h.newTenant();
    const consumer = await h.criarVisitante.execute({ tenantId: tenant.id });
    const input = {
      tenantId: tenant.id,
      applicationId: app.id,
      consumerId: consumer.id,
    };
    const results = await Promise.all(
      Array.from({ length: 15 }, () => h.attendances.openOrGet(input)),
    );
    expect(new Set(results.map((r) => r.attendance.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('após encerrar, a abertura seguinte cria novo protocolo', async () => {
    const { tenant, app } = await h.newTenant();
    const first = await h.open(tenant.id, app.id);
    await h.attendances.close({
      tenantId: tenant.id,
      id: first.attendance.id,
      reason: 'consumer_declined_more_help',
      by: 'bot',
    });
    const next = await h.attendances.openOrGet({
      tenantId: tenant.id,
      applicationId: app.id,
      consumerId: first.consumer.id,
    });
    expect(next.created).toBe(true);
    expect(next.attendance.id).not.toBe(first.attendance.id);
  });

  it('encerramento é idempotente e terminal', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const closed = await h.attendances.close({
      tenantId: tenant.id,
      id: attendance.id,
      reason: 'x',
      by: 'system',
    });
    expect(closed?.status).toBe('closed');
    expect(
      await h.attendances.close({
        tenantId: tenant.id,
        id: attendance.id,
        reason: 'y',
        by: 'agent',
      }),
    ).toBeNull();
    expect(
      (await h.attendances.get(tenant.id, attendance.id)).closedReason,
    ).toBe('x');
    // terminal também no banco: nem SQL direto reabre
    await expect(
      h.db.query(
        "UPDATE attendances SET status = 'open', closed_at = NULL WHERE id = $1",
        [attendance.id],
      ),
    ).rejects.toThrow(/terminal/);
  });
});

describe('fases', () => {
  it('controla versão otimista e transições válidas', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const pending = await h.attendances.transitionPhase({
      tenantId: tenant.id,
      id: attendance.id,
      to: 'handoff_pending',
      expectedVersion: attendance.stateVersion,
    });
    expect(pending.phase).toBe('handoff_pending');
    await expect(
      h.attendances.transitionPhase({
        tenantId: tenant.id,
        id: attendance.id,
        to: 'human',
        expectedVersion: attendance.stateVersion,
      }),
    ).rejects.toThrow(/mudou/);
    await expect(
      h.attendances.transitionPhase({
        tenantId: tenant.id,
        id: attendance.id,
        to: 'post_service',
        expectedVersion: pending.stateVersion,
      }),
    ).rejects.toThrow(/não permitida/);
  });

  it('só uma de duas transições concorrentes vence', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const attempts = await Promise.allSettled(
      (['handoff_pending', 'awaiting_business_hours'] as const).map((to) =>
        h.attendances.transitionPhase({
          tenantId: tenant.id,
          id: attendance.id,
          to,
          expectedVersion: attendance.stateVersion,
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('expiração por inatividade', () => {
  const past = async (
    tenantId: string,
    id: string,
    phase: string,
    minutesAgo = 1,
  ) =>
    h.db.query(
      `UPDATE attendances SET phase = $3, inactivity_deadline_at = now() - make_interval(mins => $4) WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, phase, minutesAgo],
    );

  it('expira pós-atendimento vencido com motivo post_service_inactivity e autor system', async () => {
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    await past(tenant.id, attendance.id, 'post_service');
    const expired = await h.attendances.expireDue();
    const mine = expired.find((a) => a.id === attendance.id)!;
    expect(mine).toMatchObject({
      status: 'expired',
      closedReason: 'post_service_inactivity',
      closedBy: 'system',
    });
  });

  it('não expira em awaiting_business_hours nem antes do prazo', async () => {
    const { tenant, app } = await h.newTenant();
    const waiting = await h.open(tenant.id, app.id);
    const fresh = await h.open(tenant.id, app.id);
    await past(
      tenant.id,
      waiting.attendance.id,
      'awaiting_business_hours',
      600,
    );
    await h.attendances.expireDue();
    expect(
      (await h.attendances.get(tenant.id, waiting.attendance.id)).status,
    ).toBe('open');
    expect(
      (await h.attendances.get(tenant.id, fresh.attendance.id)).status,
    ).toBe('open');
  });

  it('resposta e expiração concorrentes: um único vencedor, sem estado incoerente', async () => {
    for (let i = 0; i < 10; i++) {
      const { tenant, app } = await h.newTenant();
      const { attendance } = await h.open(tenant.id, app.id);
      await past(tenant.id, attendance.id, 'post_service');
      const [reply] = await Promise.allSettled([
        h.messages.append({
          tenantId: tenant.id,
          attendanceId: attendance.id,
          sender: 'consumer',
          content: { type: 'text', text: 'sim' },
        }),
        h.attendances.expireDue(),
      ]);
      const final = await h.attendances.get(tenant.id, attendance.id);
      const stored = await h.messages.list({
        tenantId: tenant.id,
        attendanceId: attendance.id,
      });
      if (reply.status === 'fulfilled') {
        // resposta venceu: prazo cancelado, segue aberto
        expect(final.status).toBe('open');
        expect(final.inactivityDeadlineAt).toBeNull();
        expect(stored).toHaveLength(1);
      } else {
        // expiração venceu: mensagem rejeitada e não persistida
        expect(final.status).toBe('expired');
        expect(stored).toHaveLength(0);
      }
    }
  });
});
