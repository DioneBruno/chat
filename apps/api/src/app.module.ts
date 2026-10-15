import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AttendancesModule } from './modules/attendances/attendances.module';
import { BotModule } from './modules/bot/bot.module';
import { BotOperationsModule } from './modules/bot-operations/bot-operations.module';
import { HumanSupportModule } from './modules/human-support/human-support.module';
import { OutboxModule } from './modules/outbox/outbox.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    DatabaseModule,
    OutboxModule,
    RealtimeModule,
    AttendancesModule,
    BotModule,
    BotOperationsModule,
    HumanSupportModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
