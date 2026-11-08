import { Body, Controller, Get, Header, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PartnerService } from './partner.service.js';
import { PartnerAdminAuthService } from './partner-admin-auth.service.js';
import { PartnerAdminGuard, type PartnerAdminRequest } from './partner-admin.guard.js';
import { AdjustPartnerCommissionDto, PartnerAdminCredentialsDto, PartnerAdminLoginDto, PartnerTermsDto, PayPartnerPayoutDto, RecordPartnerPaymentDto, RefundPartnerPaymentDto, ReviewPartnerPayoutDto } from './partner.dto.js';

@ApiTags('partner-admin')
@Controller('partner-admin')
export class PartnerAdminController {
  constructor(private readonly partners: PartnerService, private readonly auth: PartnerAdminAuthService) {}

  @Post('login') @HttpCode(200) @Header('Cache-Control', 'no-store')
  login(@Body() dto: PartnerAdminLoginDto, @Req() req: Request) { return this.auth.login(dto.login, dto.password, req.ip || req.socket.remoteAddress || 'unknown'); }

  @Get('session') @Header('Cache-Control', 'no-store') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  session(@Req() req: PartnerAdminRequest) { return { login: req.partnerAdmin.login, adminId: req.partnerAdmin.id }; }

  @Post('logout') @HttpCode(200) @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  logout(@Req() req: PartnerAdminRequest) { return this.auth.logout(req.partnerAdmin); }

  @Put('credentials') @Header('Cache-Control', 'no-store') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  credentials(@Req() req: PartnerAdminRequest, @Body() dto: PartnerAdminCredentialsDto) { return this.auth.updateCredentials(req.partnerAdmin, dto); }

  @Get('data') @Header('Cache-Control', 'no-store') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  data() { return this.partners.getData(); }

  @Put('terms') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  terms(@Req() req: PartnerAdminRequest, @Body() dto: PartnerTermsDto) { return this.partners.updateTerms(req.partnerAdmin.id, dto); }

  @Post('payouts/:id/review') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  review(@Req() req: PartnerAdminRequest, @Param('id') id: string, @Body() dto: ReviewPartnerPayoutDto) { return this.partners.reviewPayout(req.partnerAdmin.id, id, dto); }

  @Post('payouts/:id/pay') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  pay(@Req() req: PartnerAdminRequest, @Param('id') id: string, @Body() dto: PayPartnerPayoutDto) { return this.partners.markPaid(req.partnerAdmin.id, id, dto); }

  @Post('adjustments') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  adjustment(@Req() req: PartnerAdminRequest, @Body() dto: AdjustPartnerCommissionDto) { return this.partners.adjustCommission(req.partnerAdmin.id, dto); }

  @Post('payments') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  payment(@Req() req: PartnerAdminRequest, @Body() dto: RecordPartnerPaymentDto) { return this.partners.recordPayment(req.partnerAdmin.id, dto); }

  @Post('payments/:id/refunds') @ApiBearerAuth() @UseGuards(PartnerAdminGuard)
  refund(@Req() req: PartnerAdminRequest, @Param('id') id: string, @Body() dto: RefundPartnerPaymentDto) { return this.partners.refundPayment(req.partnerAdmin.id, id, dto); }
}
