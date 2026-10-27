import { Body, Controller, Delete, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { BillingGuard } from '../billing/billing.guard.js';
import { AiCooService } from './ai-coo.service.js';
import { AiCooMessageDto, AiCooScopeDto } from './ai-coo.dto.js';
import { COO_FILE_SIZE, type CooUpload } from './ai-coo-files.js';

@ApiTags('ai-coo')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, BillingGuard)
@Controller('workspace/:workspaceId/ai-coo')
export class AiCooController {
  constructor(private readonly coo: AiCooService) {}

  @Get()
  get(@Req() req: Request & { user: JwtPayload }, @Param('workspaceId') workspaceId: string, @Query() query: AiCooScopeDto) {
    return this.coo.get(req.user.sub, workspaceId, query.departmentId);
  }

  @Post('messages')
  send(@Req() req: Request & { user: JwtPayload }, @Param('workspaceId') workspaceId: string, @Body() dto: AiCooMessageDto) {
    return this.coo.send(req.user.sub, workspaceId, dto);
  }

  @Post('documents')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: COO_FILE_SIZE, files: 1, fields: 0 } }))
  upload(@Req() req: Request & { user: JwtPayload }, @Param('workspaceId') workspaceId: string,
    @Query() query: AiCooScopeDto, @UploadedFile() file?: CooUpload) {
    return this.coo.upload(req.user.sub, workspaceId, query.departmentId, file);
  }

  @Delete('documents/:documentId')
  remove(@Req() req: Request & { user: JwtPayload }, @Param('workspaceId') workspaceId: string,
    @Param('documentId') documentId: string, @Query() query: AiCooScopeDto) {
    return this.coo.removeDocument(req.user.sub, workspaceId, query.departmentId, documentId);
  }
}
