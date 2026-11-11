import { Body, Controller, Get, Header, Post, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PartnerService } from './partner.service.js';
import { PartnerDetailsDto, RegisterPartnerDto, RequestPartnerPayoutDto } from './partner.dto.js';

interface PartnerRequest extends Request { user: JwtPayload }
function userId(req: PartnerRequest): string {
  if (typeof req.user?.sub !== 'string' || !req.user.sub) throw new UnauthorizedException('Войдите в аккаунт MyCoo.');
  return req.user.sub;
}

@ApiTags('partners')
@Controller('partners')
export class PartnerController {
  constructor(private readonly partners: PartnerService) {}

  @Get('terms') terms() { return this.partners.getTerms(); }

  @Get('me') @Header('Cache-Control', 'no-store') @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  me(@Req() req: PartnerRequest) { return this.partners.getData(userId(req)); }

  @Post('register') @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  register(@Req() req: PartnerRequest, @Body() dto: RegisterPartnerDto) { return this.partners.register(userId(req), dto); }

  @Put('me/details') @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  details(@Req() req: PartnerRequest, @Body() dto: PartnerDetailsDto) { return this.partners.updateDetails(userId(req), dto); }

  @Post('me/payouts') @ApiBearerAuth() @UseGuards(JwtAuthGuard)
  payout(@Req() req: PartnerRequest, @Body() dto: RequestPartnerPayoutDto) { return this.partners.requestPayout(userId(req), dto); }
}
