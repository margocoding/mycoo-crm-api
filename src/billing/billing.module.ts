import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { RobokassaController } from './robokassa.controller.js';
import { RobokassaGateway } from './robokassa.gateway.js';
import { RobokassaService } from './robokassa.service.js';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [BillingController, RobokassaController],
  providers: [
    BillingService,
    RobokassaGateway,
    RobokassaService,
  ],
  exports: [BillingService],
})
export class BillingModule {}
