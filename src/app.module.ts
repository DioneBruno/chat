import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypebotPocModule } from './modules/bot/infrastructure/typebot/typebot-poc.module';

@Module({
  imports: [TypebotPocModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
