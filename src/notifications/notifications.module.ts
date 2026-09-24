import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { MailModule } from '../mail/mail.module.js';
import { NotificationEmails } from './notification-emails.js';

@Module({ imports: [AuthModule, PrismaModule, MailModule], controllers: [NotificationsController],
  providers: [NotificationsService, NotificationEmails], exports: [NotificationsService] })
export class NotificationsModule {}
