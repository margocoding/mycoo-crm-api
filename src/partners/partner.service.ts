import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma, PartnerTerms, PaymentOrder } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { accountBalance, addMonths, DAY, eventDate, kopecks, proportional } from './partner.money.js';
import { pageAfter, payoutNotification } from './partner.notifications.js';

type Tx = Prisma.TransactionClient;
type Details = { recipient: string; taxId: string; bank: string; account: string; bic: string; legalForm: 'self-employed' | 'entrepreneur' | 'company' };
type Terms = { commissionPercent: number; eligibleMonths: number; holdDays: number; minimumPayout: number };
type Result = { ok: true; id: string };
const ok = (id: string): Result => ({ ok: true, id });
const activePayouts = ['new', 'review', 'approved'];
const text = (value: string | undefined, max: number, required = true) => {
  const result = value?.trim() ?? '';
  if ((required && !result) || result.length > max) throw new BadRequestException('Проверьте заполнение текстовых полей.');
  return result;
};

@Injectable()
export class PartnerService {
  constructor(private readonly prisma: PrismaService) {}

  private async transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.prisma.$transaction(work, { isolationLevel: 'Serializable', timeout: 15_000 }); }
      catch (error) {
        const code = (error as { code?: string })?.code;
        if ((code === 'P2034' || code === 'P2002') && attempt < 4) continue;
        if (code === 'P2002') throw new ConflictException('Операция с таким идентификатором уже существует.');
        throw error;
      }
    }
  }

  private async lock(tx: Tx, partnerId: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`partner:${partnerId}`}))`;
  }

  private async own(tx: Tx, userId: string) {
    const partner = await tx.partner.findUnique({ where: { userId } });
    if (!partner) throw new NotFoundException('Сначала зарегистрируйтесь в партнёрской программе.');
    return partner;
  }

  private async termsAt(tx: Tx, date = new Date()) {
    const terms = await tx.partnerTerms.findFirst({ where: { effectiveAt: { lte: date } }, orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }] });
    if (!terms) throw new ConflictException('Условия программы не настроены. Обратитесь к администратору.');
    return terms;
  }

  private termsView(terms: PartnerTerms): Terms {
    return { commissionPercent: terms.commissionBps / 100, eligibleMonths: terms.eligibleMonths, holdDays: terms.holdDays, minimumPayout: terms.minimumPayoutKopecks / 100 };
  }

  async getTerms() { return this.termsView(await this.termsAt(this.prisma)); }

  private validateCursor(cursor?: string) {
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(cursor))) throw new BadRequestException('Некорректная страница.');
  }

  async ledger(userId: string, cursor?: string) {
    this.validateCursor(cursor);
    const partner = await this.own(this.prisma, userId);
    const after = cursor ? await this.prisma.partnerLedgerEntry.findFirst({ where: { id: cursor, partnerId: partner.id } }) : null;
    if (cursor && !after) throw new BadRequestException('Страница недоступна. Обновите историю.');
    const rows = await this.prisma.partnerLedgerEntry.findMany({ where: { partnerId: partner.id, ...pageAfter(after) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, include: { payment: { select: { externalId: true } } } });
    const items = rows.slice(0, 20).map(e => ({ id: e.id, partnerId: e.partnerId, referralId: e.referralId, paymentId: e.payment?.externalId ?? null,
      kind: e.kind, amount: e.amountKopecks / 100, createdAt: e.createdAt.toISOString(), availableAt: e.availableAt.toISOString(), description: e.description }));
    return { items, nextCursor: rows.length > 20 ? items[items.length - 1].id : null };
  }

  async notifications(userId: string, cursor?: string) {
    this.validateCursor(cursor);
    const partner = await this.own(this.prisma, userId);
    const where = { partnerId: partner.id };
    const after = cursor ? await this.prisma.partnerNotification.findFirst({ where: { ...where, id: cursor } }) : null;
    if (cursor && !after) throw new BadRequestException('Страница недоступна. Обновите уведомления.');
    const [rows, unreadCount] = await Promise.all([
      this.prisma.partnerNotification.findMany({ where: { ...where, ...pageAfter(after) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21,
        select: { id: true, title: true, message: true, readAt: true, createdAt: true } }),
      this.prisma.partnerNotification.count({ where: { ...where, readAt: null } }),
    ]);
    const items = rows.slice(0, 20);
    return { items, unreadCount, nextCursor: rows.length > 20 ? items[items.length - 1].id : null };
  }

  async readNotification(userId: string, id?: string) {
    const partner = await this.own(this.prisma, userId);
    const where = { partnerId: partner.id, ...(id ? { id } : {}) };
    if (id && !await this.prisma.partnerNotification.findFirst({ where, select: { id: true } })) throw new NotFoundException('Уведомление не найдено.');
    await this.prisma.partnerNotification.updateMany({ where: { ...where, readAt: null, createdAt: { lte: new Date() } }, data: { readAt: new Date() } });
    return { ok: true };
  }

  private async actorNames(tx: Tx, values: string[]) {
    const ids = [...new Set(values)];
    const [admins, partners] = await Promise.all([
      tx.partnerAdmin.findMany({ where: { id: { in: ids.filter(id => id.startsWith('admin:')).map(id => id.slice(6)) } }, select: { id: true, login: true } }),
      tx.partner.findMany({ where: { userId: { in: ids.filter(id => id.startsWith('user:')).map(id => id.slice(5)) } }, select: { userId: true, name: true } }),
    ]);
    return new Map<string, string>([['billing', 'Платёжная система'], ...admins.map(a => [`admin:${a.id}`, `Администратор ${a.login}`] as [string, string]), ...partners.map(p => [`user:${p.userId}`, p.name] as [string, string])]);
  }

  async payoutHistory(id: string) {
    if (!await this.prisma.partnerPayout.findUnique({ where: { id }, select: { id: true } })) throw new NotFoundException('Заявка не найдена.');
    const events = await this.prisma.partnerPayoutEvent.findMany({ where: { payoutId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const actors = await this.actorNames(this.prisma, events.map(e => e.actorId));
    return { items: events.map(e => ({ id: e.id, status: e.status, note: e.note, actor: actors.get(e.actorId) ?? e.actorId,
      createdAt: e.createdAt.toISOString(), amount: e.amountKopecks === null ? null : e.amountKopecks / 100 })) };
  }

  private async payoutEvent(tx: Tx, data: { partnerId: string; payoutId: string; status: string; note: string; actorId: string; amountKopecks: number }, notify = true) {
    const { partnerId, ...event } = data;
    const created = await tx.partnerPayoutEvent.create({ data: event });
    const notification = notify ? payoutNotification(data.status, data.payoutId, data.amountKopecks, data.note) : null;
    if (notification) await tx.partnerNotification.create({ data: { partnerId, eventId: created.id, ...notification } });
  }

  async register(userId: string, input: { name: string; company: string; channel?: string; website?: string }) {
    const data = { name: text(input.name, 120), company: text(input.company, 150, false), channel: text(input.channel, 250, false), website: text(input.website, 500, false) };
    return this.transaction(async tx => {
      const existing = await tx.partner.findUnique({ where: { userId } });
      if (existing) return ok(existing.id);
      const created = await tx.partner.create({ data: { ...data, userId, code: randomBytes(12).toString('base64url') } });
      return ok(created.id);
    });
  }

  // Registration only: a referral cannot be attached later or reassigned to another partner.
  async attachReferral(tx: Tx, userId: string, code?: string) {
    if (!code) return;
    const partner = await tx.partner.findUnique({ where: { code } });
    if (!partner || partner.userId === userId) return;
    const existing = await tx.partnerReferral.findUnique({ where: { referredUserId: userId } });
    if (existing) return;
    await tx.partnerReferral.create({ data: { partnerId: partner.id, referredUserId: userId } });
  }

  async getData(userId?: string) {
    return this.prisma.$transaction(async tx => {
      const partners = await tx.partner.findMany({ where: userId ? { userId } : {}, include: { user: { select: { email: true } } }, orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }] });
      const ids = partners.map(p => p.id);
      const [referrals, payments, ledger, payouts, terms, notificationUnreadCount] = await Promise.all([
        tx.partnerReferral.findMany({ where: { partnerId: { in: ids } }, include: { referredUser: { select: { subscriptions: { orderBy: { activeUntil: 'desc' }, take: 1 }, ownedWorkspaces: { select: { company: true }, orderBy: { createdAt: 'asc' }, take: 1 } } } }, orderBy: [{ registeredAt: 'desc' }, { id: 'asc' }] }),
        tx.partnerPayment.findMany({ where: { referral: { partnerId: { in: ids } } }, orderBy: [{ paidAt: 'desc' }, { id: 'asc' }] }),
        tx.partnerLedgerEntry.findMany({ where: { partnerId: { in: ids } }, include: { payment: { select: { externalId: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
        tx.partnerPayout.findMany({ where: { partnerId: { in: ids } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
        this.termsAt(tx),
        userId ? tx.partnerNotification.count({ where: { partnerId: { in: ids }, readAt: null } }) : Promise.resolve(0),
      ]);
      const now = new Date();
      const actors = userId ? new Map<string, string>() : await this.actorNames(tx, ledger.map(e => e.actorId));
      return {
        partners: partners.map(p => ({ id: p.id, code: p.code, name: p.name, email: p.user.email, company: p.company, channel: p.channel, website: p.website, registeredAt: p.registeredAt.toISOString(), payoutDetails: p.payoutDetails })),
        referrals: referrals.map(r => {
          const subscription = r.referredUser.subscriptions[0];
          const status = subscription && subscription.activeUntil <= now ? 'overdue' : subscription?.kind === 'PAID' ? 'active' : 'trial';
          return { id: r.id, partnerId: r.partnerId, company: r.referredUser.ownedWorkspaces[0]?.company || 'Компания не указана', registeredAt: r.registeredAt.toISOString(), status };
        }),
        payments: payments.map(p => ({ id: p.externalId, referralId: p.referralId, amount: p.amountKopecks / 100, refundedAmount: p.refundedKopecks / 100, paidAt: p.paidAt.toISOString() })),
        ledger: ledger.map(e => ({ id: e.id, partnerId: e.partnerId, referralId: e.referralId, paymentId: e.payment?.externalId ?? null, kind: e.kind, amount: e.amountKopecks / 100, createdAt: e.createdAt.toISOString(), availableAt: e.availableAt.toISOString(), description: e.description, ...(!userId ? { actor: actors.get(e.actorId) ?? e.actorId } : {}) })),
        payouts: payouts.map(p => ({ id: p.id, partnerId: p.partnerId, amount: p.amountKopecks / 100, status: p.status, createdAt: p.createdAt.toISOString(), reviewNote: p.reviewNote, paidAt: p.paidAt?.toISOString() ?? null, paidAmount: p.paidKopecks === null ? null : p.paidKopecks / 100, details: p.details })),
        terms: this.termsView(terms), currentPartnerId: userId ? partners[0]?.id ?? '' : '',
        notificationUnreadCount,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async updateDetails(userId: string, details: Details) {
    const data = {
      recipient: text(details.recipient, 250), bank: text(details.bank, 250), taxId: text(details.taxId, 12),
      account: text(details.account, 20), bic: text(details.bic, 9), legalForm: details.legalForm,
    };
    if (!['self-employed', 'entrepreneur', 'company'].includes(data.legalForm) ||
      !/^\d{20}$/.test(data.account) || !/^\d{9}$/.test(data.bic) ||
      !(data.legalForm === 'company' ? /^\d{10}$/ : /^\d{12}$/).test(data.taxId)) {
      throw new BadRequestException('Проверьте ИНН, БИК, счёт и форму получателя.');
    }
    return this.transaction(async tx => {
      const partner = await this.own(tx, userId);
      await this.lock(tx, partner.id);
      await tx.partner.update({ where: { id: partner.id }, data: { payoutDetails: data } });
      return ok(partner.id);
    });
  }

  private async balance(tx: Tx, partnerId: string, exceptPayoutId?: string) {
    const [ledger, payouts] = await Promise.all([
      tx.partnerLedgerEntry.findMany({ where: { partnerId } }),
      tx.partnerPayout.findMany({ where: { partnerId } }),
    ]);
    return accountBalance(ledger, payouts, new Date(), exceptPayoutId);
  }

  private operationKey(actor: string, kind: string, key: string) {
    if (!/^[\w-]{8,100}$/.test(key ?? '')) throw new BadRequestException('Укажите уникальный ключ операции.');
    return `${actor}:${kind}:${key}`;
  }

  private hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

  private async replay(tx: Tx, requestKey: string, payload: unknown) {
    const operation = await tx.partnerOperation.findUnique({ where: { requestKey } });
    if (!operation) return null;
    if (operation.payloadHash !== this.hash(payload)) throw new ConflictException('Ключ операции уже использован с другими данными.');
    return ok(operation.resultId);
  }

  private async recordOperation(tx: Tx, requestKey: string, payload: unknown, actorId: string, kind: string, resultId: string) {
    await tx.partnerOperation.create({ data: { requestKey, payloadHash: this.hash(payload), payload: payload as Prisma.InputJsonValue, actorId, kind, resultId } });
    return ok(resultId);
  }

  async requestPayout(userId: string, input: { amount: number; idempotencyKey: string }) {
    const amountKopecks = kopecks(input.amount), actor = `user:${userId}`;
    const key = this.operationKey(actor, 'payout', input.idempotencyKey), payload = { amountKopecks };
    return this.transaction(async tx => {
      const partner = await this.own(tx, userId);
      await this.lock(tx, partner.id);
      const replay = await this.replay(tx, key, payload);
      if (replay) return replay;
      const current = await tx.partner.findUniqueOrThrow({ where: { id: partner.id } });
      if (!current.payoutDetails) throw new BadRequestException('Сначала заполните платёжные реквизиты.');
      const terms = await this.termsAt(tx);
      if (amountKopecks < terms.minimumPayoutKopecks) throw new BadRequestException('Сумма меньше минимальной выплаты.');
      if ((await this.balance(tx, partner.id)).available < amountKopecks) throw new ConflictException('Недостаточно доступных средств.');
      const payout = await tx.partnerPayout.create({ data: { partnerId: partner.id, amountKopecks, details: current.payoutDetails as Prisma.InputJsonValue } });
      await this.payoutEvent(tx, { partnerId: partner.id, payoutId: payout.id, status: 'new', note: 'Заявка создана партнёром', actorId: actor, amountKopecks });
      return this.recordOperation(tx, key, payload, actor, 'payout', payout.id);
    });
  }

  async reviewPayout(adminId: string, id: string, input: { status: 'review' | 'approved' | 'rejected'; reason?: string }) {
    if (!['review', 'approved', 'rejected'].includes(input.status)) throw new BadRequestException('Некорректный статус.');
    const note = text(input.reason, 2000, input.status === 'rejected') || (input.status === 'approved' ? 'Заявка одобрена администратором' : 'Заявка взята на проверку');
    return this.transaction(async tx => {
      const initial = await tx.partnerPayout.findUnique({ where: { id } });
      if (!initial) throw new NotFoundException('Заявка не найдена.');
      await this.lock(tx, initial.partnerId);
      const payout = await tx.partnerPayout.findUniqueOrThrow({ where: { id } });
      if (payout.status === input.status && payout.reviewNote === note) return ok(id);
      if (!activePayouts.includes(payout.status)) throw new ConflictException('Заявка уже закрыта.');
      if (payout.status === 'approved' && input.status === 'review') throw new ConflictException('Одобренную заявку нельзя вернуть на проверку.');
      if (input.status === 'approved' && (await this.balance(tx, payout.partnerId)).available < 0) throw new ConflictException('Баланс изменился. Недостаточно средств для одобрения выплаты.');
      await tx.partnerPayout.update({ where: { id }, data: { status: input.status, reviewNote: note } });
      await this.payoutEvent(tx, { partnerId: payout.partnerId, payoutId: id, status: input.status, note, actorId: `admin:${adminId}`, amountKopecks: payout.amountKopecks }, payout.status !== input.status);
      return ok(id);
    });
  }

  async markPaid(adminId: string, id: string, input: { amount: number; date: string; idempotencyKey: string }) {
    const amountKopecks = kopecks(input.amount), actor = `admin:${adminId}`;
    const key = this.operationKey(actor, 'paid', input.idempotencyKey), payload = { id, amountKopecks, date: input.date };
    return this.transaction(async tx => {
      const initial = await tx.partnerPayout.findUnique({ where: { id } });
      if (!initial) throw new NotFoundException('Заявка не найдена.');
      await this.lock(tx, initial.partnerId);
      const replay = await this.replay(tx, key, payload);
      if (replay) return replay;
      const payout = await tx.partnerPayout.findUniqueOrThrow({ where: { id } });
      if (payout.status !== 'approved') throw new ConflictException('Сначала одобрите заявку.');
      if (amountKopecks > payout.amountKopecks) throw new BadRequestException('Выплата превышает сумму заявки.');
      if ((await this.balance(tx, payout.partnerId, id)).available < amountKopecks) throw new ConflictException('Баланс изменился. Недостаточно средств для выплаты.');
      const paidAt = eventDate(input.date, payout.createdAt);
      await tx.partnerPayout.update({ where: { id }, data: { status: 'paid', paidKopecks: amountKopecks, paidAt } });
      await this.payoutEvent(tx, { partnerId: payout.partnerId, payoutId: id, status: 'paid', note: `Выплата зафиксирована за ${paidAt.toISOString()}`, actorId: actor, amountKopecks });
      return this.recordOperation(tx, key, payload, actor, 'paid', id);
    });
  }

  async adjustCommission(adminId: string, input: { partnerId: string; amount: number; description: string; paymentId?: string; idempotencyKey: string }) {
    const amountKopecks = kopecks(input.amount, true), description = text(input.description, 2000), actor = `admin:${adminId}`;
    const key = this.operationKey(actor, 'adjustment', input.idempotencyKey);
    const payload = { partnerId: input.partnerId, amountKopecks, description, paymentId: input.paymentId || null };
    return this.transaction(async tx => {
      await this.lock(tx, input.partnerId);
      const replay = await this.replay(tx, key, payload);
      if (replay) return replay;
      if (!await tx.partner.findUnique({ where: { id: input.partnerId } })) throw new NotFoundException('Партнёр не найден.');
      const payment = input.paymentId ? await tx.partnerPayment.findUnique({ where: { externalId: input.paymentId }, include: { referral: true } }) : null;
      if (input.paymentId && (!payment || payment.referral.partnerId !== input.partnerId)) throw new BadRequestException('Оплата не относится к этому партнёру.');
      const entry = await tx.partnerLedgerEntry.create({ data: { partnerId: input.partnerId, referralId: payment?.referralId, paymentId: payment?.id, kind: 'adjustment', amountKopecks, availableAt: new Date(), description, actorId: actor, operationKey: key } });
      return this.recordOperation(tx, key, payload, actor, 'adjustment', entry.id);
    });
  }

  async recordPayment(adminId: string, input: { referralId: string; paymentId: string; amount: number; date?: string; idempotencyKey: string }) {
    const amountKopecks = kopecks(input.amount), externalId = text(input.paymentId, 100), actor = `admin:${adminId}`;
    if (externalId.startsWith('order:')) throw new BadRequestException('Этот формат ID зарезервирован для платежей подписки.');
    const key = this.operationKey(actor, 'payment', input.idempotencyKey);
    const payload = { referralId: input.referralId, externalId, amountKopecks, date: input.date ?? null };
    return this.transaction(async tx => {
      const referral = await tx.partnerReferral.findUnique({ where: { id: input.referralId } });
      if (!referral) throw new NotFoundException('Клиент не найден.');
      await this.lock(tx, referral.partnerId);
      const replay = await this.replay(tx, key, payload);
      if (replay) return replay;
      const existing = await tx.partnerPayment.findUnique({ where: { externalId } });
      if (existing) throw new ConflictException('Оплата с этим ID уже учтена.');
      const paidAt = eventDate(input.date, referral.registeredAt);
      const payment = await this.createPayment(tx, { referralId: referral.id, partnerId: referral.partnerId, registeredAt: referral.registeredAt, externalId, amountKopecks, paidAt, actor });
      return this.recordOperation(tx, key, payload, actor, 'payment', payment.externalId);
    });
  }

  // Called inside the verified billing transaction, never from a client-supplied payment claim.
  async creditPayment(tx: Tx, order: Pick<PaymentOrder, 'id' | 'userId' | 'status' | 'currency' | 'amountKopecks' | 'paidAt' | 'isTest'>) {
    if (order.isTest || order.status !== 'PAID' || !order.paidAt || order.currency !== 'RUB' || order.amountKopecks <= 0) return;
    const referral = await tx.partnerReferral.findUnique({ where: { referredUserId: order.userId } });
    if (!referral) return;
    await this.lock(tx, referral.partnerId);
    if (await tx.partnerPayment.findUnique({ where: { orderId: order.id } })) return;
    await this.createPayment(tx, { referralId: referral.id, partnerId: referral.partnerId, registeredAt: referral.registeredAt, externalId: `order:${order.id}`, orderId: order.id, amountKopecks: order.amountKopecks, paidAt: order.paidAt, actor: 'billing' });
  }

  private async createPayment(tx: Tx, data: { referralId: string; partnerId: string; registeredAt: Date; externalId: string; orderId?: string; amountKopecks: number; paidAt: Date; actor: string }) {
    const terms = await this.termsAt(tx, data.paidAt);
    const eligible = data.paidAt >= data.registeredAt && data.paidAt < addMonths(data.registeredAt, terms.eligibleMonths);
    const commissionKopecks = eligible ? proportional(data.amountKopecks, terms.commissionBps, 10000) : 0;
    const availableAt = new Date(data.paidAt.getTime() + terms.holdDays * DAY);
    const payment = await tx.partnerPayment.create({ data: { externalId: data.externalId, orderId: data.orderId, referralId: data.referralId, amountKopecks: data.amountKopecks, commissionKopecks, termsId: terms.id, paidAt: data.paidAt, availableAt } });
    if (commissionKopecks > 0) await tx.partnerLedgerEntry.create({ data: { partnerId: data.partnerId, referralId: data.referralId, paymentId: payment.id, kind: 'commission', amountKopecks: commissionKopecks, availableAt, description: `Комиссия ${terms.commissionBps / 100}% по оплате ${data.externalId}`, actorId: data.actor, operationKey: `commission:${payment.id}` } });
    return payment;
  }

  async refundPayment(adminId: string, paymentId: string, input: { amount: number; reason: string; idempotencyKey: string }) {
    const amountKopecks = kopecks(input.amount), reason = text(input.reason, 2000), actor = `admin:${adminId}`;
    const key = this.operationKey(actor, 'refund', input.idempotencyKey), payload = { paymentId, amountKopecks, reason };
    return this.transaction(async tx => {
      const initial = await tx.partnerPayment.findUnique({ where: { externalId: paymentId }, include: { referral: true } });
      if (!initial) throw new NotFoundException('Оплата не найдена.');
      await this.lock(tx, initial.referral.partnerId);
      const replay = await this.replay(tx, key, payload);
      if (replay) return replay;
      const payment = await tx.partnerPayment.findUniqueOrThrow({ where: { id: initial.id } });
      const refundedKopecks = payment.refundedKopecks + amountKopecks;
      if (refundedKopecks > payment.amountKopecks) throw new BadRequestException('Возврат превышает невозвращённую часть оплаты.');
      const reversal = proportional(payment.commissionKopecks, refundedKopecks, payment.amountKopecks) - proportional(payment.commissionKopecks, payment.refundedKopecks, payment.amountKopecks);
      await tx.partnerPayment.update({ where: { id: payment.id }, data: { refundedKopecks } });
      if (reversal > 0) await tx.partnerLedgerEntry.create({ data: { partnerId: initial.referral.partnerId, referralId: payment.referralId, paymentId: payment.id, kind: 'refund', amountKopecks: -reversal, availableAt: payment.availableAt, description: reason, actorId: actor, operationKey: key } });
      return this.recordOperation(tx, key, payload, actor, 'refund', payment.externalId);
    });
  }

  async updateTerms(adminId: string, input: Terms) {
    const commissionBps = Math.round(input.commissionPercent * 100);
    if (!Number.isFinite(input.commissionPercent) || input.commissionPercent < 0 || input.commissionPercent > 100 ||
      Math.abs(commissionBps - input.commissionPercent * 100) > 0.00001 ||
      !Number.isInteger(input.eligibleMonths) || input.eligibleMonths < 1 || input.eligibleMonths > 120 ||
      !Number.isInteger(input.holdDays) || input.holdDays < 0 || input.holdDays > 365) throw new BadRequestException('Проверьте условия партнёрской программы.');
    const minimumPayoutKopecks = kopecks(input.minimumPayout);
    const terms = await this.prisma.partnerTerms.create({ data: { commissionBps, eligibleMonths: input.eligibleMonths, holdDays: input.holdDays, minimumPayoutKopecks, actorId: `admin:${adminId}` } });
    return ok(terms.id);
  }
}
