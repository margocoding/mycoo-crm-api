import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TeamModule } from '../team/team.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({ imports: [AuthModule, TeamModule], controllers: [TasksController], providers: [TasksService] })
export class TasksModule {}
