import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingCoreModule } from '../billing/billing-core.module.js';
import { TeamModule } from '../team/team.module.js';
import { GigachatModule } from '../gigachat/gigachat.module.js';
import { AiCooController } from './ai-coo.controller.js';
import { AiCooService } from './ai-coo.service.js';
import { AiCooContextService } from './ai-coo-context.service.js';

@Module({
  imports: [AuthModule, BillingCoreModule, TeamModule, GigachatModule],
  controllers: [AiCooController],
  providers: [AiCooService, AiCooContextService],
})
export class AiCooModule {}
