import { createHarness } from '@modules/shared/database/testHarness';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
beforeAll(async () => void (h = await createHarness()));
afterAll(() => h.destroy());

describe('isolamento entre tenants', () => {
  it('padrão de pós-atendimento é 60 min e é configurável por tenant', async () => {
    const def = await h.newTenant();
    const custom = await h.newTenant({ postServiceInactivityMinutes: 15 });
    expect(
      (await h.tenants.getSettings(def.tenant.id)).postServiceInactivityMinutes,
    ).toBe(60);
    expect(
      (await h.tenants.getSettings(custom.tenant.id))
        .postServiceInactivityMinutes,
    ).toBe(15);
  });

  it('leituras escopadas por tenant não enxergam dados de outro', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    const att = await h.open(a.tenant.id, a.app.id);
    await expect(
      h.attendances.get(b.tenant.id, att.attendance.id),
    ).rejects.toThrow(/não encontrado/);
    await expect(
      h.messages.append({
        tenantId: b.tenant.id,
        attendanceId: att.attendance.id,
        sender: 'bot',
        content: { type: 'text', text: 'x' },
      }),
    ).rejects.toThrow(/não encontrado/);
    expect(
      await h.messages.list({
        tenantId: b.tenant.id,
        attendanceId: att.attendance.id,
      }),
    ).toEqual([]);
    expect(
      await h.tenants.getApplication(b.tenant.id, 'chat'),
    ).not.toMatchObject({ id: a.app.id });
  });

  it('não abre atendimento com aplicação ou consumidor de outro tenant', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    const consumerB = await h.criarVisitante.execute({ tenantId: b.tenant.id });
    await expect(
      h.attendances.openOrGet({
        tenantId: a.tenant.id,
        applicationId: b.app.id,
        consumerId: consumerB.id,
      }),
    ).rejects.toThrow();
    await expect(
      h.attendances.openOrGet({
        tenantId: a.tenant.id,
        applicationId: a.app.id,
        consumerId: consumerB.id,
      }),
    ).rejects.toThrow();
  });

  it('FKs compostas barram associação cruzada mesmo por SQL direto', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    const att = await h.open(a.tenant.id, a.app.id);
    await expect(
      h.db.query(
        `INSERT INTO messages (tenant_id, attendance_id, conversation_id, sender_type, content)
                  VALUES ($1, $2, gen_random_uuid(), 'bot', '{"type":"text","text":"x"}')`,
        [b.tenant.id, att.attendance.id],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      h.db.query(
        `INSERT INTO attendance_access_tokens (tenant_id, attendance_id, token_hash, expires_at)
                  VALUES ($1, $2, 'h', now() + interval '1 day')`,
        [b.tenant.id, att.attendance.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('identidade externa é única por tenant, mas independente entre tenants', async () => {
    const a = await h.newTenant();
    const b = await h.newTenant();
    const c1 = await h.buscarOuCriarConsumidor.execute({
      tenantId: a.tenant.id,
      tipo: 'whatsapp',
      valor: '+5511999990000',
    });
    const c2 = await h.buscarOuCriarConsumidor.execute({
      tenantId: a.tenant.id,
      tipo: 'whatsapp',
      valor: '+5511999990000',
    });
    const c3 = await h.buscarOuCriarConsumidor.execute({
      tenantId: b.tenant.id,
      tipo: 'whatsapp',
      valor: '+5511999990000',
    });
    expect(c2.id).toBe(c1.id);
    expect(c3.id).not.toBe(c1.id);
  });

  it('CPF/CNPJ nunca é guardado em claro', async () => {
    const a = await h.newTenant();
    await h.buscarOuCriarConsumidor.execute({
      tenantId: a.tenant.id,
      tipo: 'cpf_cnpj',
      valor: '123.456.789-09',
    });
    const { rows } = await h.db.query(
      "SELECT value FROM consumer_identities WHERE kind = 'cpf_cnpj'",
    );
    expect(rows.every((r) => r.value === null)).toBe(true);
  });
});
