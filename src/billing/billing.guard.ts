import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { BillingService } from './billing.service.js';

@Injectable()
export class BillingGuard implements CanActivate {
  constructor(private readonly billing: BillingService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest();
    await this.billing.assertWorkspaceAccess(req.user.sub, req.params.workspaceId);
    return true;
  }
}
