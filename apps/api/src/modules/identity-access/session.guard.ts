import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  AccessContext,
  IdentityAccessService,
} from './identity-access.service';

export type AuthedRequest = Request & { access: AccessContext };

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly identity: IdentityAccessService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw new UnauthorizedException();
    req.access = await this.identity.verifySession(header.slice(7));
    return true;
  }
}
