import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RedisModule } from "./redis/redis.module.js";
import { MailModule } from "./mail/mail.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { WorkspaceModule } from './workspace/workspace.module.js';
import { GigachatModule } from './gigachat/gigachat.module.js';
import { TeamModule } from './team/team.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { BillingModule } from './billing/billing.module.js';
import { MeetingsModule } from './meetings/meetings.module.js';

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
    TeamModule,
    TasksModule,
    DashboardModule,
    BillingModule,
    MeetingsModule,
  ],
})
export class AppModule {}
