import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { OutboxService } from '@modules/outbox/outbox.service';
import { DatabaseService } from '@modules/shared/database/database.service';
import { MessagesService } from '@modules/messages/messages.service';

@Module({
  providers: [criarProvedor(MessagesService, [DatabaseService, OutboxService])],
  exports: [MessagesService],
})
export class MessagesModule {}
