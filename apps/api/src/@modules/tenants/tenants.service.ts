import {
  ConflitoError,
  NaoEncontradoError,
} from '@modules/shared/error/erroAplicacao';
import {
  DatabaseService,
  isPgError,
  PG_UNIQUE_VIOLATION,
} from '@modules/shared/database/database.service';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
}

export interface TenantSettings {
  tenantId: string;
  timezone: string;
  postServiceInactivityMinutes: number;
  generalInactivityMinutes: number;
  accessLinkTtlMinutes: number;
}

export interface Application {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  channel: 'public_link' | 'whatsapp';
  authMode: 'anonymous' | 'otp';
  enabled: boolean;
}

export class TenantsService {
  constructor(private readonly db: DatabaseService) {}

  async createTenant(input: {
    slug: string;
    name: string;
    settings?: Partial<Omit<TenantSettings, 'tenantId'>>;
  }) {
    try {
      return await this.db.tx(async (client) => {
        const { rows } = await client.query<Tenant>(
          'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug, name, status',
          [input.slug, input.name],
        );
        const s = input.settings ?? {};
        // Colunas ausentes usam o DEFAULT do banco (ex.: 60 min de pós-atendimento).
        await client.query(
          `INSERT INTO tenant_settings (tenant_id, timezone, post_service_inactivity_minutes, general_inactivity_minutes, access_link_ttl_minutes)
           VALUES ($1, COALESCE($2, 'America/Sao_Paulo'), COALESCE($3, 60), COALESCE($4, 1440), COALESCE($5, 1440))`,
          [
            rows[0].id,
            s.timezone,
            s.postServiceInactivityMinutes,
            s.generalInactivityMinutes,
            s.accessLinkTtlMinutes,
          ],
        );
        return rows[0];
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION))
        throw new ConflitoError(`tenant "${input.slug}" já existe`);
      throw error;
    }
  }

  async getBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await this.db.query<Tenant>(
      "SELECT id, slug, name, status FROM tenants WHERE slug = $1 AND status = 'active'",
      [slug],
    );
    return rows[0] ?? null;
  }

  async getSettings(tenantId: string): Promise<TenantSettings> {
    const { rows } = await this.db.query<TenantSettings>(
      `SELECT tenant_id AS "tenantId", timezone,
              post_service_inactivity_minutes AS "postServiceInactivityMinutes",
              general_inactivity_minutes AS "generalInactivityMinutes",
              access_link_ttl_minutes AS "accessLinkTtlMinutes"
         FROM tenant_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (!rows[0])
      throw new NaoEncontradoError('configurações do tenant não encontradas');
    return rows[0];
  }

  async createApplication(
    tenantId: string,
    input: {
      slug: string;
      name: string;
      channel: Application['channel'];
      authMode?: Application['authMode'];
    },
  ) {
    try {
      const { rows } = await this.db.query<Application>(
        `INSERT INTO applications (tenant_id, slug, name, channel, auth_mode)
         VALUES ($1, $2, $3, $4, COALESCE($5, 'anonymous'))
         RETURNING id, tenant_id AS "tenantId", slug, name, channel, auth_mode AS "authMode", enabled`,
        [tenantId, input.slug, input.name, input.channel, input.authMode],
      );
      return rows[0];
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION))
        throw new ConflitoError(`aplicação "${input.slug}" já existe`);
      throw error;
    }
  }

  async getApplication(
    tenantId: string,
    slug: string,
  ): Promise<Application | null> {
    const { rows } = await this.db.query<Application>(
      `SELECT id, tenant_id AS "tenantId", slug, name, channel, auth_mode AS "authMode", enabled
         FROM applications WHERE tenant_id = $1 AND slug = $2 AND enabled`,
      [tenantId, slug],
    );
    return rows[0] ?? null;
  }
}
