import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ErroAplicacaoFilter } from '@http/shared/erroAplicacao.filter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from '@http/database/database.module';
import { AttendancesModule } from '@http/attendances/attendances.module';
import { BotModule } from '@http/bot/bot.module';
import { BotOperationsModule } from '@http/botOperations/botOperations.module';
import { HumanSupportModule } from '@http/humanSupport/humanSupport.module';
import { OutboxModule } from '@http/outbox/outbox.module';
import { RealtimeModule } from '@http/realtime/realtime.module';

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
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: ErroAplicacaoFilter },
  ],
})
export class AppModule {}
