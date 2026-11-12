import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { JwtModuleOptions } from "@nestjs/jwt";
import { PrismaModule } from "../../prisma/prisma.module.js";
import { MailModule } from "../mail/mail.module.js";
import { RedisModule } from "../redis/redis.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { BillingCoreModule } from '../billing/billing-core.module.js';
import { PartnerCoreModule } from '../partners/partner-core.module.js';
import { OAuthController } from './oauth.controller.js';
import { OAuthService } from './oauth.service.js';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard.js';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: { expiresIn: config.get("JWT_EXPIRES_IN", "15m") as NonNullable<JwtModuleOptions["signOptions"]>["expiresIn"] },
      }),
    }),
    PrismaModule,
    RedisModule,
    MailModule,
    BillingCoreModule,
    PartnerCoreModule,
  ],
  controllers: [AuthController, OAuthController],
  providers: [AuthService, OAuthService, JwtAuthGuard, OptionalJwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard, JwtModule],
})
export class AuthModule {}
