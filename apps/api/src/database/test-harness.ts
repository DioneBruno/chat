import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { AttendancesService } from '../modules/attendances/attendances.service';
import { ConsumersService } from '../modules/consumers/consumers.service';
import { IdentityAccessService } from '../modules/identity-access/identity-access.service';
import { OtpSender } from '../modules/identity-access/otp-sender';
import { MessagesService } from '../modules/messages/messages.service';
import { TenantsService } from '../modules/tenants/tenants.service';
import { DatabaseService } from './database.service';
import { runMigrations } from './migrator';

const URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://platform:platform@localhost:5434/platform';

/** Schema descartável por suíte: testes de integração contra um PostgreSQL real, sem tocar nos dados da POC. */
export async function createHarness() {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new DatabaseService({
    connectionString: URL,
    max: 30,
    options: `-c search_path=${schema}`,
  });
  await runMigrations(db.pool);

  const sentCodes: string[] = [];
  const sender: OtpSender = {
    send: async ({ code }) => void sentCodes.push(code),
  };
  const tenants = new TenantsService(db);
  const consumers = new ConsumersService(db);
  const attendances = new AttendancesService(db, tenants);
  const messages = new MessagesService(db);
  const identity = new IdentityAccessService(db, tenants, sender);

  let n = 0;
  const newTenant = async (
    settings?: Parameters<TenantsService['createTenant']>[0]['settings'],
  ) => {
    const tenant = await tenants.createTenant({
      slug: `t${++n}-${randomBytes(3).toString('hex')}`,
      name: `Tenant ${n}`,
      settings,
    });
    const app = await tenants.createApplication(tenant.id, {
      slug: 'chat',
      name: 'Chat',
      channel: 'public_link',
    });
    return { tenant, app };
  };
  const open = async (tenantId: string, applicationId: string) => {
    const consumer = await consumers.createVisitor(tenantId);
    return {
      consumer,
      ...(await attendances.openOrGet({
        tenantId,
        applicationId,
        consumerId: consumer.id,
      })),
    };
  };

  return {
    db,
    tenants,
    consumers,
    attendances,
    messages,
    identity,
    sentCodes,
    newTenant,
    open,
    async destroy() {
      await db.onModuleDestroy();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
