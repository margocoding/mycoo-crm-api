import {
  All,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RobokassaService } from './robokassa.service.js';

@ApiTags('billing')
@Controller('billing/payments/robokassa')
export class RobokassaController {
  constructor(private readonly robokassa: RobokassaService) {}

  /**
   * Server-to-server notification from Robokassa.
   *
   * Robokassa may send it as POST or GET depending on merchant settings.
   * This endpoint must be publicly accessible.
   */
  @All('result')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async result(
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const text = await this.robokassa.handleResult(body, query);
    return res.type('text/plain').send(text);
  }

  /**
   * Browser redirect after successful payment.
   *
   * This is not the primary confirmation source.
   * It can confirm payment only if SignatureValue is valid for Password1.
   */
  @Get('success')
  @Header('Cache-Control', 'no-store')
  async success(
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const url = await this.robokassa.handleSuccess(query);
    return res.redirect(302, url);
  }

  /**
   * Browser redirect after failed/cancelled payment.
   *
   * FailURL is usually unsigned, so by default it only redirects user.
   */
  @Get('fail')
  @Header('Cache-Control', 'no-store')
  async fail(
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const url = await this.robokassa.handleFail(query);
    return res.redirect(302, url);
  }
}