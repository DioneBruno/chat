import {
  AcessoNegadoError,
  LimiteExcedidoError,
  NaoAutorizadoError,
} from '@modules/shared/error/erroAplicacao';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'crypto';
import { DatabaseService } from '@modules/shared/database/database.service';
import { TenantsService } from '@modules/tenants/tenants.service';
import type { OtpSender } from '@modules/identityAccess/otpSender';

export interface AccessContext {
  tenantId: string;
  attendanceId: string;
  tokenId: string;
}

const OTP_TTL_MS = 10 * 60_000;
const OTP_ISSUE_WINDOW_MS = 15 * 60_000;
const OTP_MAX_ISSUES_PER_WINDOW = 3;
const SESSION_TTL_S = 12 * 3600;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Link individual (token aleatório revogável) + OTP + sessão de acesso curta.
 * Só hashes vão ao banco. O token do link não é autenticação suficiente para
 * dados sensíveis (seção 15): quando a aplicação exige OTP, a sessão só sai
 * depois de verificá-lo.
 */
export class IdentityAccessService {
  private readonly secret =
    process.env.ACCESS_SESSION_SECRET ?? 'poc-access-session-secret-change-me';
  clock: () => Date = () => new Date();

  constructor(
    private readonly db: DatabaseService,
    private readonly tenants: TenantsService,
    private readonly otpSender: OtpSender,
  ) {}

  async issueLink(
    tenantId: string,
    attendanceId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const settings = await this.tenants.getSettings(tenantId);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      this.clock().getTime() + settings.accessLinkTtlMinutes * 60_000,
    );
    await this.db.query(
      'INSERT INTO attendance_access_tokens (tenant_id, attendance_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [tenantId, attendanceId, sha256(token), expiresAt],
    );
    return { token, expiresAt };
  }

  async revokeLinks(tenantId: string, attendanceId: string) {
    await this.db.query(
      `UPDATE attendance_access_tokens SET revoked_at = now()
        WHERE tenant_id = $1 AND attendance_id = $2 AND revoked_at IS NULL`,
      [tenantId, attendanceId],
    );
  }

  /** Valida o token do link. Falha sempre com a mesma resposta (sem distinguir motivo). */
  async resolveLink(
    token: string,
  ): Promise<AccessContext & { authMode: 'anonymous' | 'otp' }> {
    const { rows } = await this.db.query<{
      id: string;
      tenantId: string;
      attendanceId: string;
      authMode: 'anonymous' | 'otp';
    }>(
      `SELECT t.id, t.tenant_id AS "tenantId", t.attendance_id AS "attendanceId", ap.auth_mode AS "authMode"
         FROM attendance_access_tokens t
         JOIN attendances a ON a.tenant_id = t.tenant_id AND a.id = t.attendance_id
         JOIN applications ap ON ap.tenant_id = a.tenant_id AND ap.id = a.application_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > $2`,
      [sha256(token ?? ''), this.clock()],
    );
    if (!rows[0]) throw new NaoAutorizadoError('link inválido ou expirado');
    return {
      tenantId: rows[0].tenantId,
      attendanceId: rows[0].attendanceId,
      tokenId: rows[0].id,
      authMode: rows[0].authMode,
    };
  }

  /** Link de aplicação anônima vira sessão direto; aplicação com OTP exige o desafio. */
  async exchangeLink(
    token: string,
  ): Promise<{ session: string } | { otpRequired: true }> {
    const link = await this.resolveLink(token);
    if (link.authMode === 'otp') return { otpRequired: true };
    return { session: this.signSession(link) };
  }

  async requestOtp(token: string): Promise<{ expiresAt: Date }> {
    const link = await this.resolveLink(token);
    const now = this.clock();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

    const challengeId = randomUUID();
    await this.db.tx(async (client) => {
      // Serializa pedidos concorrentes do mesmo link para o limite valer de fato.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 2))',
        [link.tokenId],
      );
      const recent = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM attendance_otp_challenges WHERE token_id = $1 AND created_at > $2',
        [link.tokenId, new Date(now.getTime() - OTP_ISSUE_WINDOW_MS)],
      );
      if (recent.rows[0].n >= OTP_MAX_ISSUES_PER_WINDOW) {
        throw new LimiteExcedidoError(
          'muitos códigos solicitados; aguarde alguns minutos',
        );
      }
      // Um único desafio ativo por link.
      await client.query(
        'UPDATE attendance_otp_challenges SET revoked_at = now() WHERE token_id = $1 AND used_at IS NULL AND revoked_at IS NULL',
        [link.tokenId],
      );
      await client.query(
        `INSERT INTO attendance_otp_challenges (id, tenant_id, token_id, code_hash, channel, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'unconfigured', $5, $6)`,
        [
          challengeId,
          link.tenantId,
          link.tokenId,
          this.codeHash(challengeId, code),
          expiresAt,
          now,
        ],
      );
    });
    // Envio fora da transação (chamada externa).
    await this.otpSender.send({
      tenantId: link.tenantId,
      attendanceId: link.attendanceId,
      code,
      expiresAt,
    });
    return { expiresAt };
  }

  async verifyOtp(token: string, code: string): Promise<{ session: string }> {
    const link = await this.resolveLink(token);
    const now = this.clock();
    const outcome = await this.db.tx(async (client) => {
      const { rows } = await client.query<{
        id: string;
        code_hash: string;
        attempts: number;
        max_attempts: number;
        expires_at: Date;
      }>(
        `SELECT id, code_hash, attempts, max_attempts, expires_at FROM attendance_otp_challenges
          WHERE token_id = $1 AND used_at IS NULL AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [link.tokenId],
      );
      const challenge = rows[0];
      if (
        !challenge ||
        challenge.expires_at <= now ||
        challenge.attempts >= challenge.max_attempts
      )
        return 'invalid' as const;
      // Conta a tentativa antes de comparar (o commit preserva o incremento mesmo na falha).
      await client.query(
        'UPDATE attendance_otp_challenges SET attempts = attempts + 1 WHERE id = $1',
        [challenge.id],
      );
      const expected = Buffer.from(challenge.code_hash, 'hex');
      const given = Buffer.from(
        this.codeHash(challenge.id, String(code ?? '')),
        'hex',
      );
      if (
        expected.length !== given.length ||
        !timingSafeEqual(expected, given)
      ) {
        if (challenge.attempts + 1 >= challenge.max_attempts) {
          await client.query(
            'UPDATE attendance_otp_challenges SET revoked_at = now() WHERE id = $1',
            [challenge.id],
          );
        }
        return 'invalid' as const;
      }
      await client.query(
        'UPDATE attendance_otp_challenges SET used_at = now() WHERE id = $1',
        [challenge.id],
      );
      return 'ok' as const;
    });
    if (outcome !== 'ok')
      throw new AcessoNegadoError('código inválido ou expirado');
    return { session: this.signSession(link) };
  }

  /** Sessão = HMAC(payload). Validada contra o banco: revogar o link derruba a sessão. */
  async verifySession(session: string): Promise<AccessContext> {
    const [body, signature] = (session ?? '').split('.');
    if (!body || !signature) throw new NaoAutorizadoError();
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const given = Buffer.from(signature, 'base64url');
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new NaoAutorizadoError();
    let payload: { t: string; a: string; k: string; exp: number };
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new NaoAutorizadoError();
    }
    if (payload.exp * 1000 <= this.clock().getTime())
      throw new NaoAutorizadoError('sessão expirada');
    const { rows } = await this.db.query(
      `SELECT 1 FROM attendance_access_tokens
        WHERE id = $1 AND tenant_id = $2 AND attendance_id = $3 AND revoked_at IS NULL AND expires_at > $4`,
      [payload.k, payload.t, payload.a, this.clock()],
    );
    if (!rows[0]) throw new NaoAutorizadoError('acesso revogado ou expirado');
    return { tenantId: payload.t, attendanceId: payload.a, tokenId: payload.k };
  }

  private signSession(ctx: AccessContext) {
    const exp = Math.floor(this.clock().getTime() / 1000) + SESSION_TTL_S;
    const body = Buffer.from(
      JSON.stringify({
        t: ctx.tenantId,
        a: ctx.attendanceId,
        k: ctx.tokenId,
        exp,
      }),
    ).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }

  /** Hash do OTP amarrado ao desafio (HMAC com segredo do servidor): resiste a força bruta offline. */
  private codeHash(challengeId: string, code: string) {
    return createHmac('sha256', this.secret)
      .update(`${challengeId}:${code}`)
      .digest('hex');
  }
}
