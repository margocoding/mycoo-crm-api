import { BadRequestException, Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UsageService } from './usage.service.js';

@Controller('workspace/:workspaceId/usage')
@UseGuards(JwtAuthGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}
  @Get() summary(@Req() req: Request & { user: JwtPayload }, @Param('workspaceId') id: string, @Query('departmentId') departmentId?: string) {
    if (departmentId !== undefined && (typeof departmentId !== 'string' || !departmentId || departmentId.length > 100))
      throw new BadRequestException('Некорректный департамент.');
    return this.usage.summary(req.user.sub, id, departmentId);
  }
}
