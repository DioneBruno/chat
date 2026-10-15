import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService, isPgError } from '../../database/database.service';
import { Actor } from '../attendances/attendances.service';

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'options'; text?: string; options: { id: string; label: string }[] }
  | { type: 'input'; inputType: string; text?: string };

export interface Message {
  id: string;
  seq: number;
  attendanceId: string;
  sender: Actor;
  content: MessageContent;
  createdAt: Date;
}

const COLUMNS = `id, seq::int AS seq, attendance_id AS "attendanceId", sender_type AS sender, content, created_at AS "createdAt"`;
const MAX_TEXT = 4000;

export function validateContent(content: unknown): MessageContent {
  const c = content as Partial<MessageContent> | null;
  if (!c || typeof c !== 'object')
    throw new BadRequestException('content inválido');
  const text = (c as { text?: unknown }).text;
  if (
    text !== undefined &&
    (typeof text !== 'string' || text.length > MAX_TEXT)
  ) {
    throw new BadRequestException(
      `text inválido (máx. ${MAX_TEXT} caracteres)`,
    );
  }
  switch (c.type) {
    case 'text':
      if (!text || !String(text).trim())
        throw new BadRequestException('text vazio');
      return c as MessageContent;
    case 'options':
      if (
        !Array.isArray(c.options) ||
        !c.options.every(
          (o) => typeof o?.id === 'string' && typeof o?.label === 'string',
        )
      ) {
        throw new BadRequestException('options inválido');
      }
      return c as MessageContent;
    case 'input':
      if (typeof c.inputType !== 'string')
        throw new BadRequestException('inputType inválido');
      return c as MessageContent;
    default:
      throw new BadRequestException('content.type desconhecido');
  }
}

@Injectable()
export class MessagesService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Persiste uma mensagem. Idempotente por `idempotencyKey` (reenvio devolve a
   * existente, mesmo após o encerramento). Protocolo encerrado rejeita (409).
   * Mensagem do consumidor renova/zera o prazo de inatividade na mesma transação.
   * A publicação realtime acontece DEPOIS, por quem chamou (seção 5).
   */
  async append(input: {
    tenantId: string;
    attendanceId: string;
    sender: Actor;
    content: unknown;
    idempotencyKey?: string;
    externalIds?: Record<string, unknown>;
  }): Promise<{ message: Message; duplicate: boolean }> {
    const content = validateContent(input.content);
    if (input.idempotencyKey) {
      const existing = await this.findByKey(
        input.tenantId,
        input.attendanceId,
        input.idempotencyKey,
      );
      if (existing) return { message: existing, duplicate: true };
    }
    try {
      return await this.db.tx(async (client) => {
        // Trava a linha do atendimento (serializa com close/expireDue) e confere o status.
        const lock = await client.query<{
          status: string;
          conversation_id: string;
        }>(
          `SELECT a.status, c.id AS conversation_id
             FROM attendances a JOIN conversations c ON c.tenant_id = a.tenant_id AND c.attendance_id = a.id
            WHERE a.tenant_id = $1 AND a.id = $2 FOR UPDATE OF a`,
          [input.tenantId, input.attendanceId],
        );
        if (!lock.rows[0])
          throw new NotFoundException('atendimento não encontrado');
        if (lock.rows[0].status !== 'open')
          throw new ConflictException('protocolo encerrado: somente leitura');

        if (input.sender === 'consumer') {
          // Resposta cancela o prazo de pós-atendimento; nas demais fases renova o prazo geral.
          await client.query(
            `UPDATE attendances a SET inactivity_deadline_at = CASE
                 WHEN a.phase IN ('post_service', 'awaiting_business_hours') THEN NULL
                 ELSE now() + make_interval(mins => (SELECT general_inactivity_minutes FROM tenant_settings WHERE tenant_id = a.tenant_id))
               END
              WHERE a.tenant_id = $1 AND a.id = $2`,
            [input.tenantId, input.attendanceId],
          );
        }
        const { rows } = await client.query<Message>(
          `INSERT INTO messages (tenant_id, attendance_id, conversation_id, sender_type, content, external_ids, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
          [
            input.tenantId,
            input.attendanceId,
            lock.rows[0].conversation_id,
            input.sender,
            JSON.stringify(content),
            JSON.stringify(input.externalIds ?? {}),
            input.idempotencyKey ?? null,
          ],
        );
        return { message: rows[0], duplicate: false };
      });
    } catch (error) {
      // Corrida entre dois reenvios com a mesma chave: o perdedor devolve o vencedor.
      if (input.idempotencyKey && isPgError(error, '23505')) {
        const existing = await this.findByKey(
          input.tenantId,
          input.attendanceId,
          input.idempotencyKey,
        );
        if (existing) return { message: existing, duplicate: true };
      }
      throw error;
    }
  }

  /** Histórico em ordem; `afterSeq` permite sincronizar só o que falta após reconexão. */
  async list(input: {
    tenantId: string;
    attendanceId: string;
    afterSeq?: number;
    limit?: number;
  }): Promise<Message[]> {
    const { rows } = await this.db.query<Message>(
      `SELECT ${COLUMNS} FROM messages
        WHERE tenant_id = $1 AND attendance_id = $2 AND seq > $3
        ORDER BY seq LIMIT $4`,
      [
        input.tenantId,
        input.attendanceId,
        input.afterSeq ?? 0,
        Math.min(input.limit ?? 200, 500),
      ],
    );
    return rows;
  }

  private async findByKey(
    tenantId: string,
    attendanceId: string,
    key: string,
  ): Promise<Message | null> {
    const { rows } = await this.db.query<Message>(
      `SELECT ${COLUMNS} FROM messages WHERE tenant_id = $1 AND attendance_id = $2 AND idempotency_key = $3`,
      [tenantId, attendanceId, key],
    );
    return rows[0] ?? null;
  }
}
