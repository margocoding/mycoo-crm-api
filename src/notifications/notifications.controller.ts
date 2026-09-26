import { Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { NotificationsService } from './notifications.service.js';

type AuthRequest = Request & { user: JwtPayload };

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspace/:workspaceId/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() req: AuthRequest, @Param('workspaceId') workspaceId: string, @Query('cursor') cursor?: string) {
    return this.notifications.list(req.user.sub, workspaceId, cursor);
  }

  @Patch('read-all')
  readAll(@Req() req: AuthRequest, @Param('workspaceId') workspaceId: string) {
    return this.notifications.readAll(req.user.sub, workspaceId);
  }

  @Patch(':id/read')
  read(@Req() req: AuthRequest, @Param('workspaceId') workspaceId: string, @Param('id') id: string) {
    return this.notifications.read(req.user.sub, workspaceId, id);
  }
}
