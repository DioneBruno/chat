import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { DatabaseService } from '@modules/shared/database/database.service';
import { OutboxService } from '@modules/outbox/outbox.service';
import { TenantsService } from '@modules/tenants/tenants.service';
import { ConsumersModule } from '@http/consumers/consumers.module';
import { IdentityAccessModule } from '@http/identityAccess/identityAccess.module';
import { MessagesModule } from '@http/messages/messages.module';
import { RealtimeModule } from '@http/realtime/realtime.module';
import { TenantsModule } from '@http/tenants/tenants.module';
import { AttendanceExpiryWorker } from '@modules/attendances/attendanceExpiry.worker';
import { AttendancesService } from '@modules/attendances/attendances.service';
import { PublicAttendanceController } from '@http/attendances/publicAttendance.controller';

@Module({
  imports: [
    TenantsModule,
    ConsumersModule,
    IdentityAccessModule,
    MessagesModule,
    RealtimeModule,
  ],
  controllers: [PublicAttendanceController],
  providers: [
    criarProvedor(AttendancesService, [
      DatabaseService,
      TenantsService,
      OutboxService,
    ]),
    criarProvedor(AttendanceExpiryWorker, [AttendancesService]),
  ],
  exports: [AttendancesService],
})
export class AttendancesModule {}
