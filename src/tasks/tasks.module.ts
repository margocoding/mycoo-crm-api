import { BillingCoreModule } from '../billing/billing-core.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TeamModule } from '../team/team.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { TaskRecurrenceService } from './task-recurrence.service.js';

@Module({ imports: [BillingCoreModule, AuthModule, TeamModule, DashboardModule, NotificationsModule], controllers: [TasksController], providers: [TasksService, TaskRecurrenceService] })
export class TasksModule {}
