import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { TeamModule } from '../team/team.module.js';
import { GigachatModule } from '../gigachat/gigachat.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { DashboardQueue } from './dashboard.queue.js';

@Module({ imports: [PrismaModule, TeamModule, GigachatModule, AuthModule],
  controllers: [DashboardController], providers: [DashboardService, DashboardQueue], exports: [DashboardService] })
export class DashboardModule {}
