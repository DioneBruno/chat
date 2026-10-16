import { Module } from '@nestjs/common';
import { criarProvedor } from '@http/shared/criarProvedor';
import { TenantsService } from '@modules/tenants/tenants.service';
import { DatabaseService } from '@modules/shared/database/database.service';
import { TenantsModule } from '@http/tenants/tenants.module';
import { IdentityAccessService } from '@modules/identityAccess/identityAccess.service';
import { DevLogOtpSender, OTP_SENDER } from '@modules/identityAccess/otpSender';
import { SessionGuard } from '@http/identityAccess/session.guard';

@Module({
  imports: [TenantsModule],
  providers: [
    criarProvedor(IdentityAccessService, [
      DatabaseService,
      TenantsService,
      OTP_SENDER,
    ]),
    SessionGuard,
    criarProvedor(DevLogOtpSender),
    { provide: OTP_SENDER, useExisting: DevLogOtpSender },
  ],
  exports: [IdentityAccessService, SessionGuard],
})
export class IdentityAccessModule {}
