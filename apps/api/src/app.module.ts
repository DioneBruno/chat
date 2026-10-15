import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BotOperationsPocModule } from './modules/bot-operations/bot-operations-poc.module';
import { ChatwootPocModule } from './modules/human-support/infrastructure/chatwoot/chatwoot-poc.module';
import { TypebotPocModule } from './modules/bot/infrastructure/typebot/typebot-poc.module';

@Module({
  imports: [TypebotPocModule, BotOperationsPocModule, ChatwootPocModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
