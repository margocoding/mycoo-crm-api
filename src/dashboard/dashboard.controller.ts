import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { DashboardService } from './dashboard.service.js';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspace/:workspaceId/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@Req() req: Request & { user: JwtPayload }, @Param('workspaceId') workspaceId: string,
    @Query('departmentId') departmentId?: string) {
    return this.dashboard.get(req.user.sub, workspaceId, departmentId);
  }
}
