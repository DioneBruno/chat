import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AttendancesModule } from './modules/attendances/attendances.module';
import { BotOperationsPocModule } from './modules/bot-operations/bot-operations-poc.module';
import { ChatwootPocModule } from './modules/human-support/infrastructure/chatwoot/chatwoot-poc.module';
import { TypebotPocModule } from './modules/bot/infrastructure/typebot/typebot-poc.module';

@Module({
  imports: [DatabaseModule, AttendancesModule, TypebotPocModule, BotOperationsPocModule, ChatwootPocModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
