import { Module } from '@nestjs/common';
import { TypebotPocClient } from './typebot-poc.client';
import { TypebotPocController } from './typebot-poc.controller';
import { TypebotPocStore } from './typebot-poc.store';

/**
 * Módulo temporário da POC #1. Remover/substituir quando o
 * BotOrchestratorService e o TypebotProvider reais forem implementados
 * (ver seção 17/11 do CLAUDE.md).
 */
@Module({
  controllers: [TypebotPocController],
  providers: [TypebotPocClient, TypebotPocStore],
})
export class TypebotPocModule {}
