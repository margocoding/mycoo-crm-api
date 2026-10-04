import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TeamService } from '../team/team.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { nextRecurrence, recurrenceDate, TASK_DAY } from './task-recurrence.js';

@Injectable()
export class TaskRecurrenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskRecurrenceService.name);
  private queue?: Queue;
  private worker?: Worker;
  private producer?: Redis;
  private consumer?: Redis;
  private closing = false;

  constructor(private readonly prisma: PrismaService, private readonly team: TeamService,
    private readonly notifications: NotificationsService, private readonly config: ConfigService) {}

  async onModuleInit() {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.producer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.consumer = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
    for (const connection of [this.producer, this.consumer]) connection.on('error', () => this.logger.warn('Task recurrence Redis connection unavailable'));
    this.queue = new Queue('task-recurrence', { connection: this.producer });
    this.queue.on('error', () => this.logger.warn('Task recurrence queue unavailable'));
    this.worker = new Worker('task-recurrence', () => this.runDue(), { connection: this.consumer, concurrency: 1 });
    this.worker.on('error', () => this.logger.warn('Task recurrence worker unavailable'));
    this.worker.on('failed', () => this.logger.warn('Task recurrence failed; schedule retained in database'));
    const restore = async () => {
      if (this.closing) return;
      await this.queue!.upsertJobScheduler('scan', { every: 60_000 }, { name: 'scan', data: {},
        opts: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: true, removeOnFail: 30 } });
    };
    this.producer.on('ready', () => { void restore().catch(() => this.logger.warn('Task recurrence schedule will retry on reconnect')); });
    await this.queue.waitUntilReady();
    await this.worker.waitUntilReady();
    await restore();
  }

  async runDue(now = new Date()) {
    const due = await this.prisma.task.findMany({
      where: { nextRepeatAt: { lte: now }, workspace: { isActive: true,
        owner: { subscriptions: { some: { activeUntil: { gt: now } } } } } },
      select: { id: true, workspaceId: true }, orderBy: [{ nextRepeatAt: 'asc' }, { id: 'asc' }], take: 100,
    });
    for (const row of due) {
      // One occurrence per source per pass keeps recovery bounded after a long outage.
      try { await this.team.transaction(row.workspaceId, async tx => {
        const source = await tx.task.findUnique({ where: { id: row.id }, include: {
          departments: true, assignees: true, workspace: { select: { isActive: true, owner: { select: {
            subscriptions: { where: { activeUntil: { gt: now } }, take: 1, select: { id: true } },
          } } } },
        } });
        if (!source?.nextRepeatAt || source.nextRepeatAt > now || !source.repeatDays.length
          || !source.workspace.isActive || !source.workspace.owner.subscriptions.length) return;
        if (!source.departments.length) {
          await tx.task.update({ where: { id: source.id }, data: { repeatDays: [], nextRepeatAt: null } });
          return;
        }
        const date = recurrenceDate(source.nextRepeatAt);
        const repeatDate = new Date(date);
        const existing = await tx.task.findUnique({ where: { repeatSourceId_repeatDate: { repeatSourceId: source.id, repeatDate } } });
        if (!existing) {
          const durationDays = Math.max(0, Math.round((source.dueDate.getTime() - source.startDate.getTime()) / TASK_DAY));
          const task = await tx.task.create({ data: {
            workspaceId: source.workspaceId, title: source.title, startDate: repeatDate,
            dueDate: new Date(repeatDate.getTime() + durationDays * TASK_DAY), priority: source.priority,
            successCriteria: source.successCriteria, createdById: source.createdById,
            assignedById: source.assignedById, assignedByRole: source.assignedByRole,
            repeatSourceId: source.id, repeatDate,
            departments: { create: source.departments.map(d => ({ departmentId: d.departmentId })) },
            assignees: { create: source.assignees.map(({ email, name, userId, departmentId }) => ({ email, name, userId, departmentId })) },
          }, include: { assignees: true } });
          await this.notifications.assigned(tx, task);
        }
        await tx.task.update({ where: { id: source.id }, data: {
          nextRepeatAt: nextRecurrence(source.repeatDays, date), updatedAt: source.updatedAt,
        } });
      }); } catch {
        this.logger.warn(`Task recurrence ${row.id} failed; will retry on the next scan`);
      }
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
