import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';

type EmailJob = { id?: string };
export const emailRetryDelay = (attempts: number) =>
  Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7));
const due = (now: Date) => ({
  emailSentAt: null,
  emailNextAt: { lte: now },
  OR: [{ emailLeaseUntil: null }, { emailLeaseUntil: { lt: now } }],
});

@Injectable()
export class PartnerNotificationEmails
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PartnerNotificationEmails.name);
  private queue?: Queue<EmailJob>;
  private worker?: Worker<EmailJob>;
  private producer?: Redis;
  private consumer?: Redis;
  private closing = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    if (!this.mail.configured) return;
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.producer = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.consumer = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    this.producer.on('error', () =>
      this.logger.warn('Partner email queue unavailable'),
    );
    this.consumer.on('error', () =>
      this.logger.warn('Partner email worker unavailable'),
    );
    this.producer.on('ready', () => {
      if (!this.closing)
        void this.schedule().catch(() =>
          this.logger.warn('Partner email recovery pending'),
        );
    });
    this.queue = new Queue<EmailJob>('partner-notification-emails', {
      connection: this.producer,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
    });
    this.queue.on('error', () => this.logger.warn('Partner email queue error'));
    this.worker = new Worker<EmailJob>(
      'partner-notification-emails',
      async (job) => {
        if (job.name === 'dispatch') await this.dispatch();
        else if (job.data.id) await this.deliver(job.data.id);
      },
      { connection: this.consumer, concurrency: 3 },
    );
    this.worker.on('error', () =>
      this.logger.warn('Partner email worker error'),
    );
    this.worker.on('failed', () =>
      this.logger.warn('Partner email not delivered; retained for retry'),
    );
    await this.queue.waitUntilReady();
    await this.worker.waitUntilReady();
    await this.schedule();
  }

  private async schedule() {
    await this.queue?.upsertJobScheduler(
      'dispatch',
      { every: 15_000 },
      { name: 'dispatch', data: {} },
    );
  }

  private async dispatch() {
    let cursor: string | undefined;
    while (!this.closing) {
      const rows = await this.prisma.partnerNotification.findMany({
        where: {
          ...due(new Date()),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 100,
      });
      if (!rows.length) return;
      await this.queue!.addBulk(
        rows.map(({ id }) => ({
          name: 'send',
          data: { id },
          opts: { jobId: id },
        })),
      );
      if (rows.length < 100) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  async deliver(id: string) {
    // The DB lease also excludes parallel delivery after Redis state is lost.
    const now = new Date(),
      lease = randomUUID();
    const claimed = await this.prisma.partnerNotification.updateMany({
      where: { id, ...due(now) },
      data: {
        emailLease: lease,
        emailLeaseUntil: new Date(now.getTime() + 600_000),
      },
    });
    if (!claimed.count) return;
    const item = await this.prisma.partnerNotification.findUniqueOrThrow({
      where: { id },
      include: { partner: { select: { user: { select: { email: true } } } } },
    });
    let stopped = false;
    let renewal: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRenewal = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        renewal = (async () => {
          try {
            const renewed = await this.prisma.partnerNotification.updateMany({
              where: { id, emailLease: lease, emailSentAt: null },
              data: { emailLeaseUntil: new Date(Date.now() + 600_000) },
            });
            if (!renewed.count) stopped = true;
          } catch {
            this.logger.warn('Partner email lease renewal will retry');
          } finally {
            scheduleRenewal();
          }
        })();
      }, 60_000);
      timer.unref();
    };
    const stopRenewal = async () => {
      stopped = true;
      clearTimeout(timer);
      await renewal;
    };
    scheduleRenewal();
    try {
      try {
        await this.mail.sendPartnerNotification(
          item.partner.user.email,
          id,
          item.title,
          item.message,
        );
      } finally {
        // A late heartbeat must finish before the send result clears its lease.
        await stopRenewal();
      }
      await this.prisma.partnerNotification.updateMany({
        where: { id, emailLease: lease, emailSentAt: null },
        data: {
          emailSentAt: new Date(),
          emailLease: null,
          emailLeaseUntil: null,
        },
      });
    } catch {
      await this.prisma.partnerNotification.updateMany({
        where: { id, emailLease: lease, emailSentAt: null },
        data: {
          emailAttempts: { increment: 1 },
          emailNextAt: new Date(
            Date.now() + emailRetryDelay(item.emailAttempts),
          ),
          emailLease: null,
          emailLeaseUntil: null,
        },
      });
      // SMTP errors can contain credentials or personal addresses.
      throw new Error('Partner notification email delivery failed');
    }
  }

  async onModuleDestroy() {
    this.closing = true;
    await this.worker?.close();
    await this.queue?.close();
    this.producer?.disconnect();
    this.consumer?.disconnect();
  }
}
