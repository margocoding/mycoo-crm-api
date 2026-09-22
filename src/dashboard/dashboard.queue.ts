import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';

type RefreshJob = { scopeKey?: string; revision?: number };

@Injectable()
export class DashboardQueue implements OnModuleDestroy {
  private readonly logger = new Logger(DashboardQueue.name);
  private queue?: Queue<RefreshJob>;
  private worker?: Worker<RefreshJob>;
  private producer?: Redis;
  private consumer?: Redis;
  private closing = false;

  constructor(private readonly config: ConfigService) {}

  async start(refresh: (scopeKey: string, revision: number) => Promise<void>, restore: () => Promise<void>) {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.producer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.consumer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
    this.producer.on('error', () => this.logger.warn('Dashboard queue connection unavailable'));
    this.consumer.on('error', () => this.logger.warn('Dashboard worker connection unavailable'));
    // Recover DB requests committed just before a restart or Redis outage.
    this.producer.on('ready', () => {
      if (!this.closing) void this.queue?.add('restore', {}).catch(() => this.logger.warn('Dashboard queue recovery could not start'));
    });
    this.queue = new Queue<RefreshJob>('dashboard-analysis', { connection: this.producer,
      defaultJobOptions: { attempts: 10, backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true, removeOnFail: 100 } });
    this.queue.on('error', () => this.logger.warn('Dashboard queue error'));
    this.worker = new Worker<RefreshJob>('dashboard-analysis', async job => {
      if (job.name === 'restore') await restore();
      else if (job.data.scopeKey && job.data.revision !== undefined) await refresh(job.data.scopeKey, job.data.revision);
    }, { connection: this.consumer, concurrency: 2 });
    this.worker.on('error', () => this.logger.warn('Dashboard worker error'));
    this.worker.on('failed', () => this.logger.warn('Dashboard job failed; pending data is retained'));
    await this.queue.waitUntilReady();
    await this.worker.waitUntilReady();
  }

  async schedule(scopeKey: string, revision: number, at: Date) {
    if (!this.queue) throw new Error('Dashboard queue is not started');
    const key = createHash('sha256').update(scopeKey).digest('hex');
    await this.queue.add('refresh', { scopeKey, revision }, {
      jobId: `${key}-${revision}-${at.getTime()}`, delay: Math.max(0, at.getTime() - Date.now()),
    });
  }

  async onModuleDestroy() {
    this.closing = true;
    await this.worker?.close();
    await this.queue?.close();
    this.producer?.disconnect();
    this.consumer?.disconnect();
  }
}
