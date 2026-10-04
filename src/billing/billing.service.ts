import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt } from 'node:crypto';
import type {
  BillingPeriod,
  Prisma,
  SubscriptionPlan,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  addPeriod,
  DAY,
  PLANS,
  priceFor,
  REFERRAL_DISCOUNT_PERCENT,
  TRIAL_DAYS,
} from './billing.plans.js';
import { RobokassaGateway } from './robokassa.gateway.js';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly gateway: RobokassaGateway,
  ) {}

  plans() {
    return {
      plans: PLANS,
      currency: 'RUB',
      trialDays: TRIAL_DAYS,
      paymentsAvailable: this.gateway.available,
    };
  }

  private async lock(tx: Prisma.TransactionClient, userId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`;
  }

  private current(
    db: Pick<Prisma.TransactionClient, 'subscription'>,
    userId: string,
  ) {
    return db.subscription.findFirst({
      where: { userId },
      orderBy: [{ activeUntil: 'desc' }, { id: 'asc' }],
    });
  }

  async summary(userId: string) {
    const subscription = await this.current(this.prisma, userId);
    const now = Date.now();
    return {
      status: !subscription
        ? ('NOT_STARTED' as const)
        : subscription.activeUntil.getTime() <= now
          ? ('EXPIRED' as const)
          : subscription.kind,
      plan: subscription?.plan ?? null,
      planName: PLANS.find((p) => p.id === subscription?.plan)?.name ?? null,
      activeUntil: subscription?.activeUntil.toISOString() ?? null,
      hasAccess: Boolean(
        subscription && subscription.activeUntil.getTime() > now,
      ),
      daysRemaining: subscription
        ? Math.max(
            0,
            Math.ceil((subscription.activeUntil.getTime() - now) / DAY),
          )
        : 0,
    };
  }

  async me(userId: string) {
    // The conditional update keeps a stable link when two tabs request one concurrently.
    await this.prisma.user.updateMany({
      where: { id: userId, referralCode: null },
      data: { referralCode: randomBytes(18).toString('hex') },
    });
    const [user, referrals, subscription, earnedDiscounts, availableDiscounts, pendingOrders, usedDiscounts] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { referralCode: true, pendingReferralDays: true },
      }),
      this.prisma.referral.aggregate({
        where: { inviterId: userId },
        _count: true,
        _sum: { bonusDays: true },
      }),
      this.summary(userId),
      this.prisma.referral.count({ where: { inviterId: userId, discountPercent: { gt: 0 } } }),
      this.prisma.referral.count({ where: { inviterId: userId, discountPercent: { gt: 0 }, discountOrder: { is: null } } }),
      this.prisma.paymentOrder.findMany({ where: { userId, referralDiscountId: { not: null }, status: 'PENDING' },
        select: { id: true, plan: true, period: true, amountKopecks: true, discountPercent: true }, orderBy: { createdAt: 'asc' } }),
      this.prisma.paymentOrder.count({ where: { userId, referralDiscountId: { not: null }, status: 'PAID' } }),
    ]);
    const url = new URL(this.config.get<string>('APP_URL', 'https://mycoo.io'));
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    url.searchParams.set('ref', user.referralCode!);
    return {
      subscription,
      referral: {
        url: url.toString(),
        registrations: referrals._count,
        earnedDays: referrals._sum.bonusDays ?? 0,
        pendingDays: user.pendingReferralDays,
        daysPerRegistration: 0,
        discountPercent: REFERRAL_DISCOUNT_PERCENT,
        earnedDiscounts, availableDiscounts, usedDiscounts, pendingOrders,
      },
    };
  }

  async creditReferral(
    tx: Prisma.TransactionClient,
    referredUserId: string,
    code?: string,
  ) {
    if (!code) return;
    const inviter = await tx.user.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!inviter || inviter.id === referredUserId) return;
    await this.lock(tx, inviter.id);
    await tx.referral.createMany({
      data: { inviterId: inviter.id, referredUserId, bonusDays: 0, discountPercent: REFERRAL_DISCOUNT_PERCENT },
      skipDuplicates: true,
    });
  }

  async startTrial(tx: Prisma.TransactionClient, userId: string) {
    await this.lock(tx, userId);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.trialStartedAt) return user.trialStartedAt;
    const startedAt = new Date();
    const current = await this.current(tx, userId);
    // A customer who paid before diagnostics does not receive a second trial.
    if (!current)
      await tx.subscription.create({
        data: {
          userId,
          kind: 'TRIAL',
          activeUntil: new Date(
            startedAt.getTime() + (TRIAL_DAYS + user.pendingReferralDays) * DAY,
          ),
        },
      });
    await tx.user.update({
      where: { id: userId },
      data: { trialStartedAt: startedAt, pendingReferralDays: 0 },
    });
    return startedAt;
  }

  async assertCanDiagnose(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { trialStartedAt: true },
    });
    if (user.trialStartedAt && !(await this.summary(userId)).hasAccess)
      this.expired();
  }

  expired(): never {
    throw new HttpException(
      {
        statusCode: 402,
        code: 'SUBSCRIPTION_EXPIRED',
        message:
          'Срок подписки истёк. Выберите тариф и оплатите продление доступа.',
      },
      402,
    );
  }

  async assertWorkspaceAccess(userId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { ownerId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace не найден.');
    if (!(await this.summary(workspace.ownerId)).hasAccess) this.expired();
  }

  async createOrder(
    userId: string,
    dto: {
      plan: SubscriptionPlan;
      period: BillingPeriod;
      idempotencyKey: string;
      workspaceId?: string;
    },
  ) {
    if (
      dto.workspaceId &&
      !(await this.prisma.workspace.findFirst({
        where: { id: dto.workspaceId, ownerId: userId },
        select: { id: true },
      }))
    )
      throw new NotFoundException(
        'Управлять подпиской компании может только собственник.',
      );

    if (!this.gateway.available)
      throw new ServiceUnavailableException(
        'Оплата пока недоступна. Попробуйте позже.',
      );

    const order = await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, userId);

      const current = await this.current(tx, userId);
      const now = Date.now();

      if (
        current &&
        current.kind === 'PAID' &&
        current.activeUntil.getTime() > now &&
        current.plan && current.period
      ) {
        const currentPrice = priceFor(current.plan, current.period);
        const requestedPrice = priceFor(dto.plan, dto.period);

        if (requestedPrice < currentPrice) {
          throw new BadRequestException(
            'Нельзя перейти на более дешёвый тариф до окончания текущей подписки.',
          );
        }
      }

      const existing = await tx.paymentOrder.findUnique({
        where: {
          userId_idempotencyKey: {
            userId,
            idempotencyKey: dto.idempotencyKey,
          },
        },
      });

      if (existing) {
        if (
          existing.plan !== dto.plan ||
          existing.period !== dto.period ||
          existing.status !== 'PENDING'
        )
          throw new ConflictException('Этот запрос оплаты уже использован.');

        return existing;
      }

      // Keep the original checkout usable after closing the payment page. A reward
      // stays attached to one order because an old provider link can still be paid.
      const pendingDiscount = await tx.paymentOrder.findFirst({
        where: { userId, plan: dto.plan, period: dto.period, status: 'PENDING', referralDiscountId: { not: null } },
        orderBy: { createdAt: 'asc' },
      });
      if (pendingDiscount) return pendingDiscount;
      const reward = await tx.referral.findFirst({
        where: { inviterId: userId, discountPercent: { gt: 0 }, discountOrder: { is: null } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const discountPercent = reward?.discountPercent ?? 0;
      const amountKopecks = Math.round(priceFor(dto.plan, dto.period) * (100 - discountPercent) / 100);

      return tx.paymentOrder.create({
        data: {
          userId,
          plan: dto.plan,
          period: dto.period,
          orderId: randomInt(2 ** 20),
          amountKopecks,
          discountPercent,
          referralDiscountId: reward?.id,
          idempotencyKey: dto.idempotencyKey,
        },
      });
    });

    return {
      orderId: order.id,
      checkoutUrl: await this.gateway.checkout(order),
    };
  }

  // Server-only integration point: call ONLY after checking Robokassa's notification signature.
  // There is deliberately no HTTP endpoint that accepts a client's claim of successful payment.
  async confirmVerifiedPayment(
    orderId: string,
    providerPaymentId: string,
    amountKopecks: number,
    currency: string,
  ) {
    if (!providerPaymentId || !Number.isSafeInteger(amountKopecks))
      throw new BadRequestException('Некорректный платёж.');
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.paymentOrder.findUnique({
        where: { id: orderId },
      });
      if (!initial) throw new NotFoundException('Заказ не найден.');
      await this.lock(tx, initial.userId);
      const order = await tx.paymentOrder.findUniqueOrThrow({
        where: { id: orderId },
      });
      if (order.amountKopecks !== amountKopecks || order.currency !== currency)
        throw new BadRequestException(
          'Сумма или валюта платежа не совпадает с заказом.',
        );
      if (order.status === 'PAID') {
        if (order.providerPaymentId !== providerPaymentId)
          throw new ConflictException('Заказ уже оплачен другим платежом.');
        return order;
      }
      const current = await this.current(tx, order.userId);
      const user = await tx.user.findUniqueOrThrow({
        where: { id: order.userId },
      });
      const now = new Date();

      const activeUntil = current
        ? this.calculatePaidExtension(current, order.plan, order.period, now)
        : addPeriod(new Date(now), order.period);

      activeUntil.setTime(
        activeUntil.getTime() + user.pendingReferralDays * DAY,
      );
      const data = {
        activeUntil,
        kind: 'PAID' as const,
        plan: order.plan,
        period: order.period,
      };
      if (current)
        await tx.subscription.update({ where: { id: current.id }, data });
      else
        await tx.subscription.create({
          data: { userId: order.userId, ...data },
        });
      await tx.user.update({
        where: { id: order.userId },
        data: {
          trialStartedAt: user.trialStartedAt ?? now,
          pendingReferralDays: 0,
        },
      });
      return tx.paymentOrder.update({
        where: { id: orderId },
        data: { status: 'PAID', paidAt: now, providerPaymentId },
      });
    });
  }

  private periodDays(period: BillingPeriod, from = new Date()): number {
    const to = addPeriod(new Date(from), period);
    return (to.getTime() - from.getTime()) / DAY;
  }

  private calculatePaidExtension(
    current: {
      plan: SubscriptionPlan | null;
      period: BillingPeriod | null;
      activeUntil: Date;
      kind: string;
    },
    newPlan: SubscriptionPlan,
    newPeriod: BillingPeriod,
    now: Date,
  ): Date {
    const fullExtension = addPeriod(new Date(now), newPeriod);

    if (
      current.kind !== 'PAID' ||
      !current.plan ||
      !current.period ||
      current.activeUntil.getTime() <= now.getTime()
    ) {
      return fullExtension;
    }

    if (current.plan === newPlan && current.period === newPeriod) {
      return addPeriod(
        new Date(Math.max(now.getTime(), current.activeUntil.getTime())),
        newPeriod,
      );
    }

    const remainingMs = current.activeUntil.getTime() - now.getTime();
    const remainingDays = remainingMs / DAY;

    if (remainingDays <= 0) {
      return fullExtension;
    }

    const currentPrice = priceFor(current.plan, current.period);
    const newPrice = priceFor(newPlan, newPeriod);

    const currentPeriodDays = this.periodDays(current.period, new Date(now));
    const newPeriodDays = this.periodDays(newPeriod, new Date(now));

    if (
      currentPrice <= 0 ||
      newPrice <= 0 ||
      currentPeriodDays <= 0 ||
      newPeriodDays <= 0
    ) {
      return fullExtension;
    }

    const remainingValue = (currentPrice / currentPeriodDays) * remainingDays;

    const newPricePerDay = newPrice / newPeriodDays;
    const convertedDays = remainingValue / newPricePerDay;

    return new Date(now.getTime() + Math.max(0, convertedDays) * DAY);
  }
}
