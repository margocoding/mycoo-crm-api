import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BillingService } from './billing.service.js';
import { BillingGuard } from './billing.guard.js';
import { RobokassaGateway } from './robokassa.gateway.js';

@Module({
  imports: [PrismaModule],
  providers: [BillingService, BillingGuard, RobokassaGateway],
  exports: [BillingService, BillingGuard],
})
export class BillingCoreModule {}
