export interface OperationContext {
  tenantId: string;
  attendanceId: string;
  operationId: string;
  action: string;
  parameters: Record<string, unknown>;
  signal: AbortSignal;
}

/** Resultado já sanitizado: só o que pode ir ao consumidor (seção 13). */
export interface OperationResult {
  text: string;
}

export interface OperationExecutor {
  action: string;
  /**
   * Operação que muda estado no sistema externo: nunca repetida automaticamente
   * (exigiria idempotência no sistema externo). Leitura pode repetir com backoff.
   */
  mutating: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  execute(ctx: OperationContext): Promise<OperationResult>;
}

/** Lista fechada de ações que o bot pode pedir. Ação desconhecida é recusada. */
export class OperationExecutorRegistry {
  private readonly executors = new Map<string, OperationExecutor>();

  register(executor: OperationExecutor) {
    this.executors.set(executor.action, executor);
  }

  get(action: string) {
    return this.executors.get(action);
  }
}

/**
 * Executores simulados da POC #2 (consulta de 5 s). A integração real com as APIs
 * das empresas (allowlist de hosts, proteção SSRF, credenciais segregadas, limites de
 * resposta — seções 8 e 15) substitui estes executores; contratos ainda pendentes (19.10).
 */
export class SimulatedExecutors {
  constructor(private readonly registry: OperationExecutorRegistry) {}

  onModuleInit() {
    const delay = () => Number(process.env.OP_SIMULATED_MS ?? 5000);
    const sleep = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('timeout'));
        });
      });
    this.registry.register({
      action: 'customer.requests.list',
      mutating: false,
      async execute(ctx) {
        await sleep(delay(), ctx.signal);
        return {
          text: 'Você tem 2 solicitações: #1042 (em análise) e #1038 (concluída).',
        };
      },
    });
    this.registry.register({
      action: 'customer.requests.fail',
      mutating: false,
      async execute(ctx) {
        await sleep(delay(), ctx.signal);
        throw new Error('falha simulada');
      },
    });
  }
}
