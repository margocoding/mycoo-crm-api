import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingCoreModule } from './billing-core.module.js';
import { BillingController } from './billing.controller.js';

@Module({ imports: [AuthModule, BillingCoreModule], controllers: [BillingController] })
export class BillingModule {}
