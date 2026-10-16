import { createHarness } from '@modules/shared/database/testHarness';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
beforeAll(async () => void (h = await createHarness()));
afterAll(() => h.destroy());

async function otpLink() {
  const { tenant, app } = await h.newTenant();
  await h.db.query("UPDATE applications SET auth_mode = 'otp' WHERE id = $1", [
    app.id,
  ]);
  const { attendance } = await h.open(tenant.id, app.id);
  const link = await h.identity.issueLink(tenant.id, attendance.id);
  return { tenant, attendance, token: link.token };
}

describe('link individual e OTP', () => {
  it('guarda só o hash do token', async () => {
    const { token } = await otpLink();
    const { rows } = await h.db.query(
      'SELECT token_hash FROM attendance_access_tokens',
    );
    expect(
      rows.some(
        (r) => r.token_hash === token || String(r.token_hash).includes(token),
      ),
    ).toBe(false);
    expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('aplicação com OTP não dá sessão pelo link sozinho', async () => {
    const { token } = await otpLink();
    expect(await h.identity.exchangeLink(token)).toEqual({ otpRequired: true });
  });

  it('fluxo feliz: solicita OTP, verifica e obtém sessão válida', async () => {
    const { token, attendance } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    const { session } = await h.identity.verifyOtp(token, h.sentCodes[0]);
    expect(await h.identity.verifySession(session)).toMatchObject({
      attendanceId: attendance.id,
    });
  });

  it('OTP não é reutilizável e o código nunca fica em claro no banco', async () => {
    const { token } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    const code = h.sentCodes[0];
    await h.identity.verifyOtp(token, code);
    await expect(h.identity.verifyOtp(token, code)).rejects.toThrow();
    const { rows } = await h.db.query(
      'SELECT code_hash FROM attendance_otp_challenges',
    );
    expect(rows.some((r) => r.code_hash === code)).toBe(false);
  });

  it('bloqueia após o máximo de tentativas, mesmo com o código certo depois', async () => {
    const { token } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    const good = h.sentCodes[0];
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await expect(h.identity.verifyOtp(token, wrong)).rejects.toThrow();
    await expect(h.identity.verifyOtp(token, good)).rejects.toThrow();
  });

  it('tentativas concorrentes respeitam o limite', async () => {
    const { token } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    const good = h.sentCodes[0];
    const wrong = good === '000000' ? '111111' : '000000';
    await Promise.allSettled(
      Array.from({ length: 20 }, () => h.identity.verifyOtp(token, wrong)),
    );
    const { rows } = await h.db.query(
      'SELECT attempts FROM attendance_otp_challenges ORDER BY created_at DESC LIMIT 1',
    );
    expect(rows[0].attempts).toBeLessThanOrEqual(5);
  });

  it('OTP expirado é recusado', async () => {
    const { token } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    h.identity.clock = () => new Date(Date.now() + 11 * 60_000);
    await expect(h.identity.verifyOtp(token, h.sentCodes[0])).rejects.toThrow();
    h.identity.clock = () => new Date();
  });

  it('limita a emissão de códigos e invalida o anterior', async () => {
    const { token } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    await h.identity.requestOtp(token);
    await expect(h.identity.verifyOtp(token, h.sentCodes[0])).rejects.toThrow(); // substituído
    await h.identity.requestOtp(token);
    await expect(h.identity.requestOtp(token)).rejects.toThrow(/muitos/);
  });

  it('revogar o link derruba link e sessões já emitidas', async () => {
    const { tenant, attendance, token } = await otpLink();
    h.sentCodes.length = 0;
    await h.identity.requestOtp(token);
    const { session } = await h.identity.verifyOtp(token, h.sentCodes[0]);
    await h.identity.revokeLinks(tenant.id, attendance.id);
    await expect(h.identity.verifySession(session)).rejects.toThrow();
    await expect(h.identity.exchangeLink(token)).rejects.toThrow();
  });

  it('link expirado e sessão adulterada são recusados', async () => {
    const { token } = await otpLink();
    h.identity.clock = () => new Date(Date.now() + 2 * 24 * 3600_000);
    await expect(h.identity.exchangeLink(token)).rejects.toThrow();
    h.identity.clock = () => new Date();
    const { tenant, app } = await h.newTenant();
    const { attendance } = await h.open(tenant.id, app.id);
    const { token: anon } = await h.identity.issueLink(
      tenant.id,
      attendance.id,
    );
    const { session } = (await h.identity.exchangeLink(anon)) as {
      session: string;
    };
    const [body, sig] = session.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString()),
        a: '00000000-0000-0000-0000-000000000000',
      }),
    ).toString('base64url');
    await expect(
      h.identity.verifySession(`${forged}.${sig}`),
    ).rejects.toThrow();
    await expect(h.identity.verifySession('lixo')).rejects.toThrow();
  });

  it('token de um atendimento não dá acesso a outro', async () => {
    const a = await otpLink();
    const b = await otpLink();
    expect((await h.identity.resolveLink(a.token)).attendanceId).not.toBe(
      b.attendance.id,
    );
  });
});
