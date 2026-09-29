import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { WorkspaceController } from './workspace.controller.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { GigachatModule } from '../gigachat/gigachat.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BillingCoreModule } from '../billing/billing-core.module.js';

@Module({
  imports: [PrismaModule, GigachatModule, AuthModule, BillingCoreModule],
  providers: [WorkspaceService],
  controllers: [WorkspaceController]
})
export class WorkspaceModule {}
