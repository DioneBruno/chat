/**
 * Endpoints chamados pelos blocos HTTP do Typebot (rede interna). Cada chamada traz a
 * credencial de execução emitida na criação da sessão (tenant, protocolo, sessão e
 * escopo). O token vai em `Authorization: Bearer`, `botToken` ou `chatId` (nome da
 * variável usada pelos fluxos das POCs).
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { BotExecutionTokenService } from '@modules/bot/botExecutionToken.service';
import type { BotExecutionClaims } from '@modules/bot/botExecutionToken.service';
import { BotOrchestratorService } from '@modules/bot/botOrchestrator.service';
import { BotOperationsService } from '@modules/botOperations/botOperations.service';

interface InternalBody {
  botToken?: string;
  chatId?: string;
  action?: string;
  parameters?: Record<string, unknown>;
  idempotencyKey?: string;
  reason?: string;
}

@Controller('internal/bot')
export class BotInternalController {
  constructor(
    private readonly tokens: BotExecutionTokenService,
    private readonly operations: BotOperationsService,
    private readonly orchestrator: BotOrchestratorService,
  ) {}

  @Post('operations')
  @HttpCode(200)
  create(
    @Headers('authorization') auth: string | undefined,
    @Body() body: InternalBody,
  ) {
    const claims = this.claims(auth, body);
    if (typeof body.action !== 'string') throw new UnauthorizedException();
    return this.operations.create(claims, {
      action: body.action,
      parameters: body.parameters,
      idempotencyKey: body.idempotencyKey,
    });
  }

  @Post('handoff')
  @HttpCode(200)
  handoff(
    @Headers('authorization') auth: string | undefined,
    @Body() body: InternalBody,
  ) {
    const claims = this.claims(auth, body);
    this.requireScope(claims, 'handoff');
    return this.orchestrator.requestHandoff(claims);
  }

  @Post('close')
  @HttpCode(200)
  close(
    @Headers('authorization') auth: string | undefined,
    @Body() body: InternalBody,
  ) {
    const claims = this.claims(auth, body);
    this.requireScope(claims, 'close');
    return this.orchestrator.closeByBot(claims, body.reason ?? 'bot_resolved');
  }

  private claims(
    auth: string | undefined,
    body: InternalBody,
  ): BotExecutionClaims {
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    return this.tokens.verify(bearer ?? body?.botToken ?? body?.chatId);
  }

  private requireScope(claims: BotExecutionClaims, scope: string) {
    if (!claims.scope.includes(scope))
      throw new UnauthorizedException('escopo insuficiente');
  }
}
