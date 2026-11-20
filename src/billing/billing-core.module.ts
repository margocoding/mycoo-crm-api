import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BillingService } from './billing.service.js';
import { BillingGuard } from './billing.guard.js';
import { RobokassaGateway } from './robokassa.gateway.js';
import { PartnerCoreModule } from '../partners/partner-core.module.js';
import { UsageModule } from '../usage/usage.module.js';

@Module({
  imports: [PrismaModule, PartnerCoreModule, UsageModule],
  providers: [BillingService, BillingGuard, RobokassaGateway],
  exports: [BillingService, BillingGuard],
})
export class BillingCoreModule {}
