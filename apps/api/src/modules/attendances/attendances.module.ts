import { Module } from '@nestjs/common';
import { ConsumersModule } from '../consumers/consumers.module';
import { IdentityAccessModule } from '../identity-access/identity-access.module';
import { MessagesModule } from '../messages/messages.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TenantsModule } from '../tenants/tenants.module';
import { AttendanceExpiryWorker } from './attendance-expiry.worker';
import { AttendancesService } from './attendances.service';
import { PublicAttendanceController } from './public-attendance.controller';

@Module({
  imports: [
    TenantsModule,
    ConsumersModule,
    IdentityAccessModule,
    MessagesModule,
    RealtimeModule,
  ],
  controllers: [PublicAttendanceController],
  providers: [AttendancesService, AttendanceExpiryWorker],
  exports: [AttendancesService],
})
export class AttendancesModule {}
