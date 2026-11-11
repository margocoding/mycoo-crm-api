import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { PartnerAdminAuthService, type PartnerAdminIdentity } from './partner-admin-auth.service.js';

export interface PartnerAdminRequest extends Request { partnerAdmin: PartnerAdminIdentity }

@Injectable()
export class PartnerAdminGuard implements CanActivate {
  constructor(private readonly auth: PartnerAdminAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PartnerAdminRequest>();
    request.partnerAdmin = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
