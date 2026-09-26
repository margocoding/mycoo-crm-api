import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MailService } from '../mail/mail.service.js';

type EmailJob = { id?: string };
const ATTEMPTS = 6;

@Injectable()
export class NotificationEmails implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationEmails.name);
  private queue?: Queue<EmailJob>;
  private worker?: Worker<EmailJob>;
  private producer?: Redis;
  private consumer?: Redis;
  private closing = false;

  constructor(private readonly prisma: PrismaService, private readonly mail: MailService,
    private readonly config: ConfigService) {}

  async onModuleInit() {
    // Keep the persisted outbox pending until SMTP is configured.
    if (!this.mail.configured) return;
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.producer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.consumer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
    this.producer.on('error', () => this.logger.warn('Notification queue connection unavailable'));
    this.consumer.on('error', () => this.logger.warn('Notification worker connection unavailable'));
    this.producer.on('ready', () => {
      if (!this.closing) void this.schedule().catch(() => this.logger.warn('Notification recovery could not start'));
    });
    this.queue = new Queue<EmailJob>('notification-emails', { connection: this.producer,
      defaultJobOptions: { attempts: ATTEMPTS, backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true, removeOnFail: 100 } });
    this.queue.on('error', () => this.logger.warn('Notification queue error'));
    this.worker = new Worker<EmailJob>('notification-emails', async job => {
      if (job.name === 'dispatch') return this.dispatch();
      if (!job.data.id) return;
      try { await this.deliver(job.data.id); }
      catch {
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? ATTEMPTS)) await this.prisma.notification.updateMany({
          where: { id: job.data.id, emailStatus: 'PENDING' }, data: { emailStatus: 'FAILED' },
        });
        // Do not put SMTP errors containing addresses or credentials in Redis/logs.
        throw new Error('Notification email delivery failed');
      }
    }, { connection: this.consumer, concurrency: 3 });
    this.worker.on('error', () => this.logger.warn('Notification worker error'));
    this.worker.on('failed', job => this.logger.warn(`Notification email job failed: ${job?.id ?? 'unknown'}`));
    await this.queue.waitUntilReady();
    await this.worker.waitUntilReady();
    await this.schedule();
  }

  private async schedule() {
    await this.queue?.upsertJobScheduler('dispatch', { every: 15_000 }, { name: 'dispatch', data: {} });
  }

  // The notification itself is the outbox, committed atomically with the task/role.
  private async dispatch() {
    let cursor: string | undefined;
    while (!this.closing) {
      const pending = await this.prisma.notification.findMany({ where: { emailStatus: 'PENDING',
        ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take: 200, select: { id: true } });
      if (!pending.length) return;
      await this.queue!.addBulk(pending.map(({ id }) => ({ name: 'send', data: { id }, opts: { jobId: id } })));
      if (pending.length < 200) return;
      cursor = pending[pending.length - 1].id;
    }
  }

  async deliver(id: string) {
    const item = await this.prisma.notification.findUnique({ where: { id }, include: {
      recipient: { select: { email: true } }, workspace: { select: { company: true, ownerId: true,
        members: { select: { userId: true } } } },
      task: { select: { assignees: { select: { userId: true } } } },
    } });
    if (!item || item.emailStatus !== 'PENDING') return;
    const member = item.workspace.ownerId === item.recipientId || item.workspace.members.some(m => m.userId === item.recipientId);
    const relevant = item.kind === 'TASK_ASSIGNED' ? item.task?.assignees.some(a => a.userId === item.recipientId)
      : item.departmentId && await this.prisma.departmentMember.findUnique({
        where: { departmentId_userId: { departmentId: item.departmentId, userId: item.recipientId } }, select: { userId: true },
      });
    if (!member || !relevant) {
      await this.prisma.notification.updateMany({ where: { id, emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
      return;
    }
    await this.mail.sendNotification(item.recipient.email, item.id, item.kind, item.workspace.company || 'Ваша компания', item.message);
    await this.prisma.notification.updateMany({ where: { id, emailStatus: 'PENDING' }, data: { emailStatus: 'SENT', emailSentAt: new Date() } });
  }

  async onModuleDestroy() {
    this.closing = true;
    await this.worker?.close();
    await this.queue?.close();
    this.producer?.disconnect();
    this.consumer?.disconnect();
  }
}
