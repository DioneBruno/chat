import { Module } from '@nestjs/common';
import { TypebotPocModule } from '../../../bot/infrastructure/typebot/typebot-poc.module';
import { RealtimeModule } from '../../../realtime/realtime.module';
import { ChatwootPocClient } from './chatwoot-poc.client';
import { ChatwootPocController } from './chatwoot-poc.controller';
import { ChatwootPocService } from './chatwoot-poc.service';

/** Módulo temporário da POC #3. */
@Module({
  imports: [TypebotPocModule, RealtimeModule],
  controllers: [ChatwootPocController],
  providers: [ChatwootPocClient, ChatwootPocService],
  exports: [ChatwootPocClient],
})
export class ChatwootPocModule {}
