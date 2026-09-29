import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { BillingService } from './billing.service.js';
import { PaymentGateway } from './payment.gateway.js';
import { BillingGuard } from './billing.guard.js';

@Module({
  imports: [PrismaModule],
  providers: [BillingService, PaymentGateway, BillingGuard],
  exports: [BillingService, BillingGuard],
})
export class BillingCoreModule {}
