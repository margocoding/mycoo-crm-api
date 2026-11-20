import { ForbiddenException, HttpException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Prisma, UsageEntry } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GIGACHAT_RATES, LIMITS, RUB, usageMonth, zeroUsage, type UsageAmount, type UsagePlan, type UsageScope } from './usage.policy.js';

type Tx = Prisma.TransactionClient;
const held = ['RESERVED', 'UNKNOWN', 'CONFIRMED'];
const labels: Record<string, string> = { aiBudget: 'AI-бюджет', inputTokens: 'Входные токены', outputTokens: 'Выходные токены', audioSeconds: 'Распознавание речи', users: 'Пользователи', tasks: 'Незавершённые задачи', storageBytes: 'Хранилище' };

@Injectable()
export class UsageService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private exceeded(resource: string): never {
    throw new HttpException({ code: 'USAGE_LIMIT_REACHED', resource,
      message: `${labels[resource] ?? 'Ресурс'}: достигнут лимит тарифа или остатка недостаточно для этого действия.` }, 403);
  }

  private async account(tx: Tx, workspaceId: string) {
    const workspace = await tx.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { ownerId: true } });
    if (!workspace) throw new NotFoundException('Компания недоступна.');
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', 'usage:' + workspace.ownerId);
    const [owner, subscription] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: workspace.ownerId }, select: { createdAt: true, trialStartedAt: true } }),
      tx.subscription.findFirst({ where: { userId: workspace.ownerId }, orderBy: [{ activeUntil: 'desc' }, { id: 'asc' }] }),
    ]);
    return { ownerId: workspace.ownerId, owner, subscription };
  }

  private async window(tx: Tx, workspaceId: string, beforeTrial = false, readOnly = false) {
    const account = await this.account(tx, workspaceId);
    const { ownerId, owner, subscription } = account;
    const now = new Date();
    if (!readOnly && !(subscription && subscription.activeUntil > now)
      && !(beforeTrial && !owner.trialStartedAt && !subscription))
      throw new HttpException({ code: 'SUBSCRIPTION_EXPIRED', message: 'Продлите подписку для продолжения работы.' }, 402);
    const plan: UsagePlan = subscription?.kind === 'PAID' && subscription.plan ? subscription.plan : 'TRIAL';
    const dates = plan === 'TRIAL'
      ? { start: owner.trialStartedAt ?? subscription?.createdAt ?? owner.createdAt, end: subscription?.activeUntil ?? null }
      : usageMonth(subscription!.usageAnchorAt ?? subscription!.createdAt, now);
    const key = ownerId + ':' + (plan === 'TRIAL' ? 'trial' : dates.start.toISOString());
    const window = await tx.usageWindow.upsert({ where: { key },
      create: { key, ownerId, startAt: dates.start, endAt: dates.end }, update: { startAt: dates.start, endAt: dates.end } });
    return { ...account, window, plan, limits: LIMITS[plan] };
  }

  private async total(tx: Tx, windowId: string, statuses = held): Promise<UsageAmount> {
    const value = await tx.usageEntry.aggregate({ where: { windowId, kind: 'AI', status: { in: statuses } },
      _sum: { costMicros: true, inputTokens: true, outputTokens: true, audioSeconds: true } });
    return { costMicros: Number(value._sum.costMicros ?? 0), inputTokens: value._sum.inputTokens ?? 0,
      outputTokens: value._sum.outputTokens ?? 0, audioSeconds: value._sum.audioSeconds ?? 0 };
  }

  private validate(amount: UsageAmount) {
    if (!Object.values(amount).every(n => Number.isSafeInteger(n) && n >= 0))
      throw new ServiceUnavailableException('Не удалось определить стоимость операции.');
  }

  async reserve(scope: UsageScope, amount: UsageAmount, model?: string) {
    this.validate(amount);
    return this.prisma.$transaction(async tx => {
      const { ownerId, window, limits } = await this.window(tx, scope.workspaceId, scope.allowBeforeTrial);
      const used = await this.total(tx, window.id);
      if (used.costMicros + amount.costMicros > limits.budgetRub * RUB) this.exceeded('aiBudget');
      for (const resource of ['inputTokens', 'outputTokens', 'audioSeconds'] as const) {
        const maximum = limits[resource];
        if (maximum !== null && used[resource] + amount[resource] > maximum) this.exceeded(resource);
      }
      return tx.usageEntry.create({ data: { ...amount, costMicros: BigInt(amount.costMicros),
        ownerId, windowId: window.id, workspaceId: scope.workspaceId, actorId: scope.actorId,
        source: scope.source, departmentId: scope.departmentId, model, operationKey: randomUUID() } });
    });
  }

  async settle(id: string, amount: UsageAmount | null, status: 'CONFIRMED' | 'UNKNOWN' | 'RELEASED' = 'CONFIRMED') {
    if (amount) this.validate(amount);
    await this.prisma.$transaction(async tx => {
      const entry = await tx.usageEntry.findUniqueOrThrow({ where: { id } });
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', 'usage:' + entry.ownerId);
      const changed = await tx.usageEntry.updateMany({ where: { id, status: { in: ['RESERVED', 'UNKNOWN'] } }, data: {
        status, settledAt: new Date(), ...(amount ? { ...amount, costMicros: BigInt(amount.costMicros) } : {}),
      } });
      if (changed.count && status !== 'RELEASED' && entry.kind === 'AI') await this.warn(tx, entry);
    });
  }

  private async warn(tx: Tx, entry: UsageEntry) {
    const workspace = await tx.workspace.findFirst({ where: { id: entry.workspaceId, deletedAt: null }, select: { ownerId: true } });
    if (!workspace) return;
    const current = await this.window(tx, entry.workspaceId, false, true);
    if (current.window.id !== entry.windowId) return;
    const used = await this.total(tx, entry.windowId, ['CONFIRMED', 'UNKNOWN']);
    const percent = used.costMicros * 100 / (current.limits.budgetRub * RUB);
    const level = percent >= 100 ? 100 : percent >= 90 ? 90 : percent >= 80 ? 80 : 0;
    const previous = current.window.warningBudgetRub === current.limits.budgetRub ? current.window.warningLevel : 0;
    if (!level || level <= previous) return;
    const admins = await tx.departmentMember.findMany({ where: { role: 'ADMIN', department: { workspaceId: entry.workspaceId } }, select: { userId: true } });
    const recipients = new Set([workspace.ownerId, ...admins.map(a => a.userId)]);
    await tx.notification.createMany({ data: [...recipients].map(recipientId => ({
      recipientId, workspaceId: entry.workspaceId, kind: 'AI_BUDGET' as const,
      message: level === 100 ? 'AI-бюджет компании исчерпан. Новые AI-запросы приостановлены до обновления бюджета.'
        : `Использовано ${level}% AI-бюджета компании. ${level === 90 ? 'Бюджет скоро закончится.' : 'Проверьте расход в дашборде.'}`,
    })) });
    await tx.usageWindow.update({ where: { id: entry.windowId }, data: { warningLevel: level, warningBudgetRub: current.limits.budgetRub } });
  }

  rates(model: string) {
    let configured: Record<string, { input: number; output: number }> = {};
    try { configured = JSON.parse(this.config.get<string>('AI_MODEL_RATES_JSON', '{}')); } catch { /* fail closed below */
      throw new ServiceUnavailableException('Не настроена стоимость AI-модели.');
    }
    const rates = configured?.[model] ?? GIGACHAT_RATES[model];
    if (!rates || ![rates.input, rates.output].every(n => Number.isFinite(n) && n > 0 && n <= 1_000_000))
      throw new ServiceUnavailableException('Не настроена стоимость AI-модели.');
    return rates;
  }

  speechAmount(seconds: number, provider: string): UsageAmount {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 14_400) throw new ServiceUnavailableException('Не удалось определить длительность записи.');
    const rate = Number(this.config.get(provider === 'yandex' ? 'YANDEX_SPEECH_RUB_PER_SECOND' : 'SALUTE_SPEECH_RUB_PER_SECOND', provider === 'yandex' ? '0.0101' : ''));
    if (!['yandex', 'salute'].includes(provider) || !Number.isFinite(rate) || rate <= 0)
      throw new ServiceUnavailableException('Не настроена стоимость распознавания.');
    return { ...zeroUsage(), audioSeconds: Math.ceil(seconds), costMicros: Math.ceil(Math.max(15, Math.ceil(seconds)) * rate * RUB) };
  }

  private async people(tx: Tx, ownerId: string) {
    const owner = await tx.user.findUniqueOrThrow({ where: { id: ownerId }, select: { email: true } });
    const [members, invitations] = await Promise.all([
      tx.workspaceMember.findMany({ where: { workspace: { ownerId, deletedAt: null } }, select: { user: { select: { email: true } } } }),
      tx.teamInvitation.findMany({ where: { department: { workspace: { ownerId, deletedAt: null } }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { email: true } }),
    ]);
    return new Set([owner.email, ...members.map(m => m.user.email), ...invitations.map(i => i.email)].map(e => e.toLowerCase()));
  }

  async assertSeat(tx: Tx, workspaceId: string, email: string) {
    const { ownerId, limits } = await this.window(tx, workspaceId);
    const people = await this.people(tx, ownerId);
    const size = people.size + (people.has(email.toLowerCase()) ? 0 : 1);
    if (size > limits.users) this.exceeded('users');
  }

  async assertTasks(tx: Tx, workspaceId: string, additional = 1) {
    const { ownerId, limits } = await this.window(tx, workspaceId);
    const count = await tx.task.count({ where: { workspace: { ownerId, deletedAt: null }, status: { not: 'done' } } });
    if (count + additional > limits.tasks) this.exceeded('tasks');
  }

  private async storage(tx: Tx, ownerId: string) {
    const [documents, recordings, unknownRecordings, reserved] = await Promise.all([
      tx.aiCooDocument.aggregate({ where: { conversation: { workspace: { ownerId } } }, _sum: { size: true } }),
      tx.meetingRecording.aggregate({ where: { meeting: { workspace: { ownerId } }, fileKey: { not: null } }, _sum: { sizeBytes: true } }),
      tx.meetingRecording.count({ where: { meeting: { workspace: { ownerId } }, fileKey: { not: null }, sizeBytes: null } }),
      tx.usageEntry.aggregate({ where: { ownerId, kind: 'STORAGE', status: { in: ['RESERVED', 'UNKNOWN'] } }, _sum: { storageBytes: true } }),
    ]);
    // Old recordings are reconciled from storage by the meetings worker. Until
    // then reserve the existing per-file download ceiling rather than count 0.
    const used = (documents._sum.size ?? 0) + Number(recordings._sum.sizeBytes ?? 0) + unknownRecordings * 2_000_000_000;
    return { usedBytes: used, reservedBytes: Number(reserved._sum.storageBytes ?? 0), unknownRecordings };
  }

  async reserveStorage(tx: Tx, workspaceId: string, bytes: number, operationKey: string, actorId?: string) {
    const { ownerId, window, limits } = await this.window(tx, workspaceId);
    const previous = await tx.usageEntry.findUnique({ where: { operationKey } });
    if (previous) return previous;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new ServiceUnavailableException('Не удалось определить размер файла.');
    const usage = await this.storage(tx, ownerId);
    if (usage.usedBytes + usage.reservedBytes + bytes > limits.storageBytes) this.exceeded('storageBytes');
    return tx.usageEntry.create({ data: { ownerId, workspaceId, windowId: window.id, actorId,
      operationKey, kind: 'STORAGE', source: 'file', storageBytes: BigInt(bytes) } });
  }

  async releaseStorage(tx: Tx, operationKey: string) {
    await tx.usageEntry.updateMany({ where: { operationKey, kind: 'STORAGE' }, data: { status: 'RELEASED', settledAt: new Date() } });
  }

  async lockStorage(tx: Tx, workspaceId: string) {
    await this.account(tx, workspaceId);
  }

  async summary(userId: string, workspaceId: string, departmentId?: string) {
    const access = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }] }, select: { ownerId: true } });
    if (!access) throw new NotFoundException('Компания недоступна.');
    const isOwner = access.ownerId === userId;
    const departments = await this.prisma.department.findMany({ where: { workspaceId,
      ...(isOwner ? {} : { members: { some: { userId } } }) },
      select: { id: true, members: { where: { userId }, select: { role: true } } } });
    if (departmentId && !departments.some(d => d.id === departmentId)) throw new ForbiddenException('Нет доступа к департаменту.');
    const managed = departments.filter(d => isOwner || d.members.some(m => m.role === 'CHIEF' || m.role === 'ADMIN'))
      .filter(d => !departmentId || d.id === departmentId).map(d => d.id);
    return this.prisma.$transaction(async tx => {
      const { ownerId, window, limits, plan } = await this.window(tx, workspaceId, false, true);
      const [used, reserved, storage, people, taskCount] = await Promise.all([
        this.total(tx, window.id, ['CONFIRMED']), this.total(tx, window.id, ['RESERVED', 'UNKNOWN']),
        this.storage(tx, ownerId), this.people(tx, ownerId),
        tx.task.count({ where: { workspace: { ownerId, deletedAt: null }, status: { not: 'done' } } }),
      ]);
      const scope: Prisma.UsageEntryWhereInput = isOwner && !departmentId ? {}
        : managed.length ? { departmentId: { in: managed } }
        : { actorId: userId, ...(departmentId ? { departmentId } : {}) };
      const rows = await tx.usageEntry.groupBy({ by: ['actorId'], where: { windowId: window.id, workspaceId, kind: 'AI', status: 'CONFIRMED',
        ...scope }, _sum: { inputTokens: true, outputTokens: true, costMicros: true, audioSeconds: true } });
      const peopleById = new Map((await tx.user.findMany({ where: { id: { in: rows.flatMap(r => r.actorId ? [r.actorId] : []) } }, select: { id: true, name: true } })).map(u => [u.id, u.name || 'Участник']));
      const topEmployees = rows.filter(r => r.actorId && (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0) > 0)
        .map(r => ({ id: r.actorId!, name: peopleById.get(r.actorId!) ?? 'Бывший участник', inputTokens: r._sum.inputTokens ?? 0,
          outputTokens: r._sum.outputTokens ?? 0, totalTokens: (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0), costRub: Number(r._sum.costMicros ?? 0) / RUB }))
        .sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id)).slice(0, 10);
      const automatic = rows.find(r => r.actorId === null);
      return { plan, periodStart: window.startAt.toISOString(), periodEnd: window.endAt?.toISOString() ?? null,
        limits, used: { ...used, costRub: used.costMicros / RUB, users: people.size, tasks: taskCount, storageBytes: storage.usedBytes },
        reserved: { ...reserved, costRub: reserved.costMicros / RUB, storageBytes: storage.reservedBytes },
        storagePending: storage.unknownRecordings > 0, topEmployees,
        automaticCostRub: Number(automatic?._sum.costMicros ?? 0) / RUB,
        rankingScope: isOwner && !departmentId ? 'company' : managed.length ? 'departments' : 'personal',
        updatedAt: new Date().toISOString() };
    });
  }
}
