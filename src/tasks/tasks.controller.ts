import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { TaskDto, TaskStatusDto } from './dto/task.dto.js';
import { TasksService } from './tasks.service.js';

interface AuthenticatedRequest extends Request { user: JwtPayload; }
interface TaskParams { workspaceId: string; departmentId: string; taskId: string; }

@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspace/:workspaceId/departments/:departmentId/tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Param() p: TaskParams) {
    return this.tasks.list(req.user.sub, p.workspaceId, p.departmentId);
  }

  @Post()
  create(@Req() req: AuthenticatedRequest, @Param() p: TaskParams, @Body() dto: TaskDto) {
    return this.tasks.create(req.user.sub, p.workspaceId, p.departmentId, dto);
  }

  @Patch(':taskId')
  update(@Req() req: AuthenticatedRequest, @Param() p: TaskParams, @Body() dto: TaskDto) {
    return this.tasks.update(req.user.sub, p.workspaceId, p.departmentId, p.taskId, dto);
  }

  @Patch(':taskId/status')
  status(@Req() req: AuthenticatedRequest, @Param() p: TaskParams, @Body() dto: TaskStatusDto) {
    return this.tasks.setStatus(req.user.sub, p.workspaceId, p.departmentId, p.taskId, dto.status);
  }

  @Delete(':taskId')
  remove(@Req() req: AuthenticatedRequest, @Param() p: TaskParams) {
    return this.tasks.remove(req.user.sub, p.workspaceId, p.departmentId, p.taskId);
  }
}
