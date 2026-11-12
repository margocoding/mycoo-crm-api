import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { PartnerCoreModule } from './partner-core.module.js';
import { PartnerController } from './partner.controller.js';
import { PartnerAdminController } from './partner-admin.controller.js';
import { PartnerAdminAuthService } from './partner-admin-auth.service.js';
import { PartnerAdminGuard } from './partner-admin.guard.js';
import { MailModule } from '../mail/mail.module.js';
import { PartnerNotificationEmails } from './partner-notification-emails.js';

@Module({
  imports: [PartnerCoreModule, AuthModule, RedisModule, MailModule],
  controllers: [PartnerController, PartnerAdminController],
  providers: [PartnerAdminAuthService, PartnerAdminGuard, PartnerNotificationEmails],
})
export class PartnerModule {}
