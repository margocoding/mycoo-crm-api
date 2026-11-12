import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { OAuthService } from './oauth.service.js';
import { OAuthExchangeDto, OAuthStartDto } from './oauth.dto.js';

@Controller('auth/oauth')
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}
  @Get('providers') providers() { return this.oauth.providers(); }
  @Post('exchange') @HttpCode(200) @Header('Cache-Control', 'no-store')
  exchange(@Body() dto: OAuthExchangeDto) { return this.oauth.exchange(dto); }
  @Post(':provider/start') @HttpCode(200)
  start(@Param('provider') provider: string, @Body() dto: OAuthStartDto, @Req() req: Request) {
    return this.oauth.start(provider, dto, req.ip || req.socket.remoteAddress || 'unknown');
  }
  @Get(':provider/callback')
  async callback(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Res() res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const ticket = await this.oauth.callback(provider, query);
      return res.redirect(this.oauth.frontendCallback({ ticket }));
    } catch {
      return res.redirect(this.oauth.frontendCallback({ error: 'Вход не завершён. Попробуйте ещё раз или войдите по почте.' }));
    }
  }
}
