import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { TeamController, InvitationsController } from './team.controller.js';
import { TeamService } from './team.service.js';
import { MailModule } from '../mail/mail.module.js';

@Module({
  imports: [AuthModule, RedisModule, MailModule],
  controllers: [TeamController, InvitationsController],
  providers: [TeamService],
})
export class TeamModule {}
