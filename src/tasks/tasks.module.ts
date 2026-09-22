import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TeamModule } from '../team/team.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';

@Module({ imports: [AuthModule, TeamModule, DashboardModule], controllers: [TasksController], providers: [TasksService] })
export class TasksModule {}
