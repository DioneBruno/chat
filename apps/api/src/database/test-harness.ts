/* eslint-disable @typescript-eslint/require-await -- fakes implementam contratos assíncronos */
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AttendancesService } from '../modules/attendances/attendances.service';
import { ConsumersService } from '../modules/consumers/consumers.service';
import { IdentityAccessService } from '../modules/identity-access/identity-access.service';
import { OtpSender } from '../modules/identity-access/otp-sender';
import { BotConfigService } from '../modules/bot/application/bot-config.service';
import { BotExecutionTokenService } from '../modules/bot/application/bot-execution-token.service';
import { BotFlowResolverService } from '../modules/bot/application/bot-flow-resolver.service';
import { BotOrchestratorService } from '../modules/bot/application/bot-orchestrator.service';
import type {
  BotProvider,
  BotTurnResult,
  ContinueBotSessionInput,
  StartBotSessionInput,
} from '../modules/bot/domain/bot-provider.interface';
import { BotOperationsService } from '../modules/bot-operations/bot-operations.service';
import { BotOperationsWorker } from '../modules/bot-operations/bot-operations.worker';
import { OperationExecutorRegistry } from '../modules/bot-operations/operation-executors';
import { HumanSupportService } from '../modules/human-support/application/human-support.service';
import type { HumanSupportProvider } from '../modules/human-support/domain/human-support-provider.interface';
import { IntegrationInboxService } from '../modules/integration-inbox/integration-inbox.service';
import { MessagesService } from '../modules/messages/messages.service';
import { OutboxDispatcher } from '../modules/outbox/outbox.dispatcher';
import { OutboxService } from '../modules/outbox/outbox.service';
import { OutboxWorker } from '../modules/outbox/outbox.worker';
import { TenantsService } from '../modules/tenants/tenants.service';
import { DatabaseService } from './database.service';
import { runMigrations } from './migrator';

const URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://platform:platform@localhost:5434/platform';

/** Typebot falso e roteirizável: registra chamadas e permite simular o bloco HTTP dentro do `startChat`. */
export class FakeBotProvider implements BotProvider {
  starts: StartBotSessionInput[] = [];
  continues: ContinueBotSessionInput[] = [];
  sessionCounter = 0;
  /** Executa dentro do `startSession` (ex.: o bloco HTTP chamando `/internal/bot/operations`). */
  onStart?: (input: StartBotSessionInput) => Promise<void>;
  startError?: Error;
  continueErrors: Error[] = [];
  startTurn: (input: StartBotSessionInput) => BotTurnResult = () => ({
    messages: [{ type: 'text', text: 'Olá! Como posso ajudar?' }],
    input: {
      type: 'options',
      options: [
        { id: 'opt-a', label: 'Consultar solicitações' },
        { id: 'opt-h', label: 'Falar com atendente' },
      ],
    },
  });
  continueTurn: (input: ContinueBotSessionInput) => BotTurnResult = (
    input,
  ) => ({
    messages: [{ type: 'text', text: `Recebi: ${input.text}` }],
    input: { type: 'input', inputType: 'text input' },
  });

  async startSession(input: StartBotSessionInput) {
    this.starts.push(input);
    if (this.startError) throw this.startError;
    const providerSessionId = `ps-${++this.sessionCounter}`;
    await this.onStart?.(input);
    return { ...this.startTurn(input), providerSessionId };
  }

  async continueSession(input: ContinueBotSessionInput) {
    this.continues.push(input);
    const error = this.continueErrors.shift();
    if (error) throw error;
    return this.continueTurn(input);
  }
}

/** Chatwoot falso: conversas e mensagens em memória. */
export class FakeHumanProvider implements HumanSupportProvider {
  conversations: {
    externalConversationId: string;
    existingContact?: unknown;
  }[] = [];
  sent: { conversationId: string; content: string; private: boolean }[] = [];
  createFailures = 0;
  sendFailures = 0;
  /** Ids de conversa nunca se repetem (como no Chatwoot): o banco persiste entre os testes. */
  nextId = 100;

  createOrGetConversation: HumanSupportProvider['createOrGetConversation'] =
    async (input) => {
      if (this.createFailures > 0) {
        this.createFailures--;
        throw new Error('Chatwoot indisponível');
      }
      const externalConversationId = String(this.nextId++);
      this.conversations.push({
        externalConversationId,
        existingContact: input.existingContact,
      });
      return {
        externalConversationId,
        externalContactId:
          input.existingContact?.externalContactId ?? 'contact-1',
        externalSourceId: input.existingContact?.externalSourceId ?? 'source-1',
        externalAccountId: '1',
        externalInboxId: '1',
      };
    };

  sendMessage: HumanSupportProvider['sendMessage'] = async (input) => {
    if (this.sendFailures > 0) {
      this.sendFailures--;
      throw new Error('falha ao enviar');
    }
    this.sent.push({
      conversationId: input.externalConversationId,
      content: input.content,
      private: !!input.private,
    });
    return { externalMessageId: randomUUID() };
  };
}

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
  const outbox = new OutboxService(db);
  const attendances = new AttendancesService(db, tenants, outbox);
  const messages = new MessagesService(db, outbox);
  const identity = new IdentityAccessService(db, tenants, sender);

  // --- etapa 5: outbox, bot, operações e humano (provedores externos falsos) ---
  const dispatcher = new OutboxDispatcher();
  const outboxWorker = new OutboxWorker(outbox, dispatcher);
  const botProvider = new FakeBotProvider();
  const humanProvider = new FakeHumanProvider();
  const tokens = new BotExecutionTokenService();
  const resolver = new BotFlowResolverService(db);
  const botConfig = new BotConfigService(db);
  const orchestrator = new BotOrchestratorService(
    db,
    attendances,
    messages,
    resolver,
    tokens,
    outbox,
    dispatcher,
    botProvider,
  );
  const registry = new OperationExecutorRegistry();
  const botOps = new BotOperationsService(db, outbox, registry);
  const opsWorker = new BotOperationsWorker(botOps, registry);
  const inbox = new IntegrationInboxService(db);
  const human = new HumanSupportService(
    db,
    attendances,
    messages,
    inbox,
    outbox,
    dispatcher,
    humanProvider,
  );
  orchestrator.onModuleInit();
  human.onModuleInit();
  // Handlers de realtime: registra um coletor (Centrifugo falso) com falha opcional.
  const published: { attendanceId: string; event: string }[] = [];
  const realtime = { failures: 0 };
  dispatcher.register('realtime.publish', async (e) => {
    if (realtime.failures > 0) {
      realtime.failures--;
      throw new Error('Centrifugo fora do ar');
    }
    published.push({
      attendanceId: e.attendanceId!,
      event: String((e.payload as { event?: string }).event),
    });
  });
  registry.register({
    action: 'test.read',
    mutating: false,
    execute: async () => ({ text: 'resultado da consulta' }),
  });

  /** Processa o outbox e as operações até assentar (eventos com backoff futuro ficam de fora). */
  const drain = async (rounds = 30) => {
    for (let i = 0; i < rounds; i++) {
      const handled =
        (await outboxWorker.runOnce()) + (await opsWorker.runOnce());
      if (!handled) return;
    }
    throw new Error('outbox não assentou');
  };
  /** Faz eventos reagendados (backoff) ficarem elegíveis agora. */
  const makeDue = () =>
    db.query(
      `UPDATE outbox_events SET next_attempt_at = now() WHERE status = 'pending';
       UPDATE bot_operations SET next_attempt_at = now() WHERE status = 'pending'`,
    );

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
  /** Tenant com fluxos `initial` e `post_service` cadastrados (default da empresa). */
  const newBotTenant = async (
    settings?: Parameters<TenantsService['createTenant']>[0]['settings'],
  ) => {
    const t = await newTenant(settings);
    const providerId = await botConfig.registerProvider({
      name: `typebot-${randomBytes(3).toString('hex')}`,
      endpoint: 'http://typebot.test/api',
    });
    const workspaceId = await botConfig.registerWorkspace({
      tenantId: t.tenant.id,
      botProviderId: providerId,
      externalWorkspaceId: `ws-${randomBytes(3).toString('hex')}`,
    });
    for (const kind of ['initial', 'post_service'] as const)
      await botConfig.registerFlow({
        tenantId: t.tenant.id,
        workspaceId,
        kind,
        externalFlowId: `flow-${kind}`,
      });
    return { ...t, workspaceId };
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
    outbox,
    dispatcher,
    outboxWorker,
    botProvider,
    humanProvider,
    tokens,
    resolver,
    botConfig,
    orchestrator,
    registry,
    botOps,
    opsWorker,
    inbox,
    human,
    published,
    realtime,
    drain,
    makeDue,
    newBotTenant,
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
