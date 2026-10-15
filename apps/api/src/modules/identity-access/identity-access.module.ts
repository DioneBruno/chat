import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { IdentityAccessService } from './identity-access.service';
import { DevLogOtpSender, OTP_SENDER } from './otp-sender';
import { SessionGuard } from './session.guard';

@Module({
  imports: [TenantsModule],
  providers: [
    IdentityAccessService,
    SessionGuard,
    { provide: OTP_SENDER, useClass: DevLogOtpSender },
  ],
  exports: [IdentityAccessService, SessionGuard],
})
export class IdentityAccessModule {}
