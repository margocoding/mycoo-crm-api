import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AcceptInvitationDto, DepartmentDto, InvitationDto, MemberDepartmentsDto, MemberRoleDto } from './dto/team.dto.js';
import { TeamService } from './team.service.js';

interface AuthenticatedRequest extends Request { user: JwtPayload; }

@ApiTags('team')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspace/:workspaceId/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  get(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string) {
    return this.team.getTeam(req.user.sub, id);
  }

  @Post('departments')
  createDepartment(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string, @Body() dto: DepartmentDto) {
    return this.team.createDepartment(req.user.sub, id, dto);
  }

  @Patch('departments/:departmentId')
  editDepartment(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string,
    @Param('departmentId') departmentId: string, @Body() dto: DepartmentDto) {
    return this.team.editDepartment(req.user.sub, id, departmentId, dto);
  }

  @Post('departments/:departmentId/invitations')
  invite(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string,
    @Param('departmentId') departmentId: string, @Body() dto: InvitationDto) {
    return this.team.invite(req.user.sub, id, departmentId, dto);
  }

  @Delete('invitations/:invitationId')
  revoke(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string, @Param('invitationId') invitationId: string) {
    return this.team.revoke(req.user.sub, id, invitationId);
  }

  @Patch('departments/:departmentId/members/:userId')
  setRole(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string,
    @Param('departmentId') departmentId: string, @Param('userId') userId: string, @Body() dto: MemberRoleDto) {
    return this.team.setRole(req.user.sub, id, departmentId, userId, dto.role);
  }

  @Delete('departments/:departmentId/members/:userId')
  removeMember(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string,
    @Param('departmentId') departmentId: string, @Param('userId') userId: string) {
    return this.team.removeMember(req.user.sub, id, departmentId, userId);
  }

  @Patch('members/:userId/departments')
  setDepartments(@Req() req: AuthenticatedRequest, @Param('workspaceId') id: string,
    @Param('userId') userId: string, @Body() dto: MemberDepartmentsDto) {
    return this.team.setDepartments(req.user.sub, id, userId, dto.departmentIds);
  }
}

@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly team: TeamService) {}

  @Get(':token')
  get(@Param('token') token: string) { return this.team.getInvitation(token); }

  @Post(':token/accept')
  @HttpCode(200)
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.team.accept(token, dto.password);
  }
}
