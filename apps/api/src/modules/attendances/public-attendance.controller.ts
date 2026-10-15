/**
 * API pública do chat (consumidor). O browser só envia texto e o token de
 * acesso: tenant, aplicação, consumidor e atendimento vêm sempre da sessão
 * validada pelo NestJS (seção 8). Roteamento ao Typebot/Chatwoot entra na
 * etapa 5 (bot_sessions/orquestrador); aqui as mensagens só são persistidas.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConsumersService } from '../consumers/consumers.service';
import { SessionGuard } from '../identity-access/session.guard';
import type { AuthedRequest } from '../identity-access/session.guard';
import { IdentityAccessService } from '../identity-access/identity-access.service';
import { MessagesService } from '../messages/messages.service';
import { TenantsService } from '../tenants/tenants.service';
import { AttendancesService } from './attendances.service';
import type { Attendance } from './attendances.service';

const str = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !value.trim())
    throw new BadRequestException(`${field} obrigatório`);
  return value.trim();
};

@Controller('public')
export class PublicAttendanceController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly consumers: ConsumersService,
    private readonly attendances: AttendancesService,
    private readonly identity: IdentityAccessService,
    private readonly messages: MessagesService,
  ) {}

  /** Entrada pelo link público genérico: visitante anônimo recebe protocolo e sessão. */
  @Post('attendances')
  async start(@Body() body: { tenant?: string; application?: string }) {
    const tenant = await this.tenants.getBySlug(str(body?.tenant, 'tenant'));
    const app =
      tenant &&
      (await this.tenants.getApplication(
        tenant.id,
        str(body?.application, 'application'),
      ));
    if (!tenant || !app)
      throw new NotFoundException('aplicação não encontrada');
    // Aplicações com OTP recebem o link por canal verificado (ex.: WhatsApp), nunca por esta rota.
    if (app.authMode !== 'anonymous' || app.channel !== 'public_link') {
      throw new ForbiddenException('esta aplicação não aceita entrada anônima');
    }
    const consumer = await this.consumers.createVisitor(tenant.id);
    return this.openAndIssue(tenant.id, app.id, consumer.id);
  }

  @Post('access/exchange')
  @HttpCode(200)
  exchange(@Body() body: { token?: string }) {
    return this.identity.exchangeLink(str(body?.token, 'token'));
  }

  @Post('access/otp/request')
  @HttpCode(202)
  async requestOtp(@Body() body: { token?: string }) {
    await this.identity.requestOtp(str(body?.token, 'token'));
    return { sent: true };
  }

  @Post('access/otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() body: { token?: string; code?: string }) {
    return this.identity.verifyOtp(
      str(body?.token, 'token'),
      str(body?.code, 'code'),
    );
  }

  @Get('attendance')
  @UseGuards(SessionGuard)
  async current(@Req() req: AuthedRequest, @Query('after') after?: string) {
    const { tenantId, attendanceId } = req.access;
    const attendance = await this.attendances.get(tenantId, attendanceId);
    const messages = await this.messages.list({
      tenantId,
      attendanceId,
      afterSeq: Number(after) || 0,
    });
    return { attendance: this.toDto(attendance), messages };
  }

  @Post('attendance/messages')
  @UseGuards(SessionGuard)
  async send(
    @Req() req: AuthedRequest,
    @Body() body: { text?: string; idempotencyKey?: string },
  ) {
    const { tenantId, attendanceId } = req.access;
    const { message, duplicate } = await this.messages.append({
      tenantId,
      attendanceId,
      sender: 'consumer',
      content: { type: 'text', text: str(body?.text, 'text') },
      idempotencyKey:
        typeof body?.idempotencyKey === 'string'
          ? body.idempotencyKey.slice(0, 200)
          : undefined,
    });
    return { message, duplicate };
  }

  /** Botão "abrir novo protocolo" (seção 4.8): só vale depois do encerramento. */
  @Post('attendance/restart')
  @UseGuards(SessionGuard)
  async restart(@Req() req: AuthedRequest) {
    const { tenantId, attendanceId } = req.access;
    const previous = await this.attendances.get(tenantId, attendanceId);
    if (previous.status === 'open')
      throw new BadRequestException('o protocolo atual ainda está aberto');
    return this.openAndIssue(
      tenantId,
      previous.applicationId,
      previous.consumerId,
    );
  }

  private async openAndIssue(
    tenantId: string,
    applicationId: string,
    consumerId: string,
  ) {
    const { attendance, created } = await this.attendances.openOrGet({
      tenantId,
      applicationId,
      consumerId,
    });
    const link = await this.identity.issueLink(tenantId, attendance.id);
    const exchanged = await this.identity.exchangeLink(link.token);
    return {
      attendance: this.toDto(attendance),
      created,
      linkToken: link.token,
      ...exchanged,
    };
  }

  private toDto(a: Attendance) {
    return {
      id: a.id,
      protocolNumber: a.protocolNumber,
      status: a.status,
      phase: a.phase,
      closedReason: a.closedReason,
      createdAt: a.createdAt,
      closedAt: a.closedAt,
    };
  }
}
