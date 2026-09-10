import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { MailModule } from "./mail/mail.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { WorkspaceModule } from './workspace/workspace.module.js';
import { GigachatModule } from './gigachat/gigachat.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    RedisModule,
    MailModule,
    AuthModule,
    WorkspaceModule,
    GigachatModule,
  ],
})
export class AppModule {}
