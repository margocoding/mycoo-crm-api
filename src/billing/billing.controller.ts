import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import {
  BillingPeriod,
  SubscriptionPlan,
} from '../../generated/prisma/client.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { BillingService } from './billing.service.js';

export class CreateOrderDto {
  @IsEnum(SubscriptionPlan) plan!: SubscriptionPlan;
  @IsEnum(BillingPeriod) period!: BillingPeriod;
  @IsUUID() idempotencyKey!: string;
  @IsOptional() @IsString() @Length(1, 128) workspaceId?: string;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get('plans') plans() {
    return this.billing.plans();
  }
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@Req() req: Request & { user: JwtPayload }) {
    return this.billing.me(req.user.sub);
  }
  @Post('orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  order(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: CreateOrderDto,
  ) {
    return this.billing.createOrder(req.user.sub, dto);
  }
}
