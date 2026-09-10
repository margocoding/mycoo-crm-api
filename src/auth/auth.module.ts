import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import type { JwtModuleOptions } from "@nestjs/jwt";
import { PrismaModule } from "../../prisma/prisma.module.js";
import { MailModule } from "../mail/mail.module.js";
import { RedisModule } from "../redis/redis.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";

@Module({
  imports: [
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
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
