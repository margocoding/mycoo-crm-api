import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MailService } from '../mail/mail.service.js';
import {
  PartnerNotificationEmails,
  emailRetryDelay,
} from './partner-notification-emails.js';
import { PartnerService } from './partner.service.js';
import { payoutNotification } from './partner.notifications.js';

vi.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

function emailFixture() {
  const item = {
    id: 'notice',
    title: 'Заявка одобрена',
    message: 'Выплата',
    emailAttempts: 0,
    emailSentAt: null,
    partner: { user: { email: 'partner@example.test' } },
  };
  const db = {
    partnerNotification: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(item),
    },
  };
  const mail = {
    configured: false,
    sendPartnerNotification: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db,
    mail,
    item,
    service: new PartnerNotificationEmails(
      db as unknown as PrismaService,
      mail as unknown as MailService,
      {} as ConfigService,
    ),
  };
}

describe('partner notification outbox', () => {
  it('renews the lease through a long SMTP send and excludes a second worker after the original lease expires', async () => {
    vi.useFakeTimers();
    try {
      const f = emailFixture();
      const state = {
        emailLease: null as string | null,
        emailLeaseUntil: null as Date | null,
        emailSentAt: null as Date | null,
      };
      f.db.partnerNotification.updateMany.mockImplementation(
        async ({ where, data }: any) => {
          if (state.emailSentAt) return { count: 0 };
          if (
            where.OR &&
            state.emailLeaseUntil &&
            state.emailLeaseUntil >= new Date()
          )
            return { count: 0 };
          if (where.emailLease && where.emailLease !== state.emailLease)
            return { count: 0 };
          Object.assign(state, data);
          return { count: 1 };
        },
      );
      let finishSend!: () => void;
      f.mail.sendPartnerNotification.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSend = resolve;
          }),
      );
      const sending = f.service.deliver('notice');
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(state.emailLeaseUntil!.getTime()).toBeGreaterThan(Date.now());
      const otherWorker = new PartnerNotificationEmails(
        f.db as unknown as PrismaService,
        f.mail as unknown as MailService,
        {} as ConfigService,
      );
      await otherWorker.deliver('notice');
      expect(f.mail.sendPartnerNotification).toHaveBeenCalledOnce();
      finishSend();
      await sending;
      expect(state.emailSentAt).toBeInstanceOf(Date);
      expect(state.emailLease).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('waits for an in-flight renewal before writing SMTP acceptance and clearing the lease', async () => {
    vi.useFakeTimers();
    try {
      const f = emailFixture();
      let finishSend!: () => void;
      let finishRenewal!: (value: { count: number }) => void;
      f.mail.sendPartnerNotification.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSend = resolve;
          }),
      );
      f.db.partnerNotification.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRenewal = resolve;
            }),
        );
      const sending = f.service.deliver('notice');
      await vi.advanceTimersByTimeAsync(60_000);
      finishSend();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.db.partnerNotification.updateMany).toHaveBeenCalledTimes(2);
      finishRenewal({ count: 1 });
      await sending;
      expect(f.db.partnerNotification.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            emailSentAt: expect.any(Date),
            emailLease: null,
          }),
        }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('handles a failed heartbeat and removes its timer when SMTP fails', async () => {
    vi.useFakeTimers();
    try {
      const f = emailFixture();
      let failSend!: (reason: Error) => void;
      f.mail.sendPartnerNotification.mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            failSend = reject;
          }),
      );
      f.db.partnerNotification.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockRejectedValueOnce(new Error('temporary DB outage'));
      const sending = f.service.deliver('notice');
      const failed = expect(sending).rejects.toThrow(
        'Partner notification email delivery failed',
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.db.partnerNotification.updateMany).toHaveBeenCalledTimes(3);
      failSend(new Error('SMTP unavailable'));
      await failed;
      expect(vi.getTimerCount()).toBe(0);
      expect(f.db.partnerNotification.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            emailLease: null,
            emailAttempts: { increment: 1 },
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('delivers to the partner without requiring any workspace and records SMTP acceptance', async () => {
    const f = emailFixture();
    await f.service.deliver('notice');
    expect(f.mail.sendPartnerNotification).toHaveBeenCalledWith(
      'partner@example.test',
      'notice',
      f.item.title,
      f.item.message,
    );
    expect(f.db.partnerNotification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailSentAt: expect.any(Date),
          emailLease: null,
        }),
      }),
    );
  });
  it('does not send a sent or concurrently leased notification again', async () => {
    const f = emailFixture();
    f.db.partnerNotification.updateMany.mockResolvedValueOnce({ count: 0 });
    await f.service.deliver('notice');
    expect(f.mail.sendPartnerNotification).not.toHaveBeenCalled();
  });
  it('keeps an SMTP failure in the database for a later retry without exposing its error', async () => {
    const f = emailFixture();
    f.mail.sendPartnerNotification.mockRejectedValue(
      new Error('private SMTP details'),
    );
    await expect(f.service.deliver('notice')).rejects.toThrow(
      'Partner notification email delivery failed',
    );
    expect(f.db.partnerNotification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          emailAttempts: { increment: 1 },
          emailNextAt: expect.any(Date),
          emailLease: null,
          emailLeaseUntil: null,
        },
      }),
    );
    expect(emailRetryDelay(0)).toBe(30_000);
    expect(emailRetryDelay(100)).toBe(3_600_000);
  });
  it('retains pending notifications when SMTP is not configured', async () => {
    const f = emailFixture();
    await f.service.onModuleInit();
    expect(f.db.partnerNotification.updateMany).not.toHaveBeenCalled();
  });
  it('notifies on the four requested states and includes the rejection reason and actual payout amount', () => {
    for (const status of ['new', 'approved', 'rejected', 'paid'])
      expect(
        payoutNotification(status, 'payout', 12345, 'Проверьте реквизиты'),
      ).toBeTruthy();
    expect(payoutNotification('review', 'payout', 12345)).toBeNull();
    expect(
      payoutNotification('rejected', 'payout', 12345, 'Проверьте реквизиты')
        ?.message,
    ).toContain('Проверьте реквизиты');
    expect(payoutNotification('paid', 'payout', 12345)?.message).toContain(
      '123,45',
    );
  });
});

describe('partner private history', () => {
  function fixture() {
    const db = {
      partner: { findUnique: vi.fn().mockResolvedValue({ id: 'own' }) },
      partnerLedgerEntry: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      partnerNotification: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn(),
      },
    };
    return { db, service: new PartnerService(db as unknown as PrismaService) };
  }
  it('rejects another partner cursor before querying ledger or notifications', async () => {
    const f = fixture();
    await expect(f.service.ledger('user', 'foreign')).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      f.service.notifications('user', 'foreign'),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.db.partnerLedgerEntry.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign', partnerId: 'own' },
    });
    expect(f.db.partnerLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(f.db.partnerNotification.findMany).not.toHaveBeenCalled();
  });
  it('never marks another partner notification read', async () => {
    const f = fixture();
    await expect(
      f.service.readNotification('user', 'foreign'),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.db.partnerNotification.updateMany).not.toHaveBeenCalled();
  });
  it('uses creation time and ID to paginate equal-time ledger entries without gaps', async () => {
    const f = fixture(),
      createdAt = new Date('2026-11-11T10:00:00Z');
    f.db.partnerLedgerEntry.findFirst.mockResolvedValue({
      id: 'last',
      createdAt,
    });
    await f.service.ledger('user', 'last');
    expect(f.db.partnerLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          partnerId: 'own',
          OR: [
            { createdAt: { lt: createdAt } },
            { createdAt, id: { lt: 'last' } },
          ],
        },
        take: 21,
      }),
    );
  });
});

describe('payout status notification idempotency', () => {
  function fixture(status: string, reviewNote: string) {
    const payout = {
      id: 'payout',
      partnerId: 'partner',
      status,
      reviewNote,
      amountKopecks: 5000,
    };
    const tx = {
      $executeRaw: vi.fn(),
      partnerPayout: {
        findUnique: vi.fn().mockResolvedValue(payout),
        findUniqueOrThrow: vi.fn().mockResolvedValue(payout),
        update: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      partnerLedgerEntry: { findMany: vi.fn().mockResolvedValue([]) },
      partnerPayoutEvent: {
        create: vi.fn().mockResolvedValue({ id: 'event' }),
      },
      partnerNotification: { create: vi.fn() },
    };
    const service = new PartnerService({
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    } as unknown as PrismaService);
    return { tx, service };
  }
  it('records one notification on the approval transition', async () => {
    const f = fixture('review', 'Проверка');
    await f.service.reviewPayout('admin', 'payout', { status: 'approved' });
    expect(f.tx.partnerNotification.create).toHaveBeenCalledOnce();
    expect(f.tx.partnerNotification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ partnerId: 'partner', eventId: 'event' }),
    });
  });
  it('does not create another event or notice when the request is retried', async () => {
    const f = fixture('approved', 'Заявка одобрена администратором');
    await f.service.reviewPayout('admin', 'payout', { status: 'approved' });
    expect(f.tx.partnerPayoutEvent.create).not.toHaveBeenCalled();
    expect(f.tx.partnerNotification.create).not.toHaveBeenCalled();
  });
  it('retains a comment amendment in the audit without repeating the approval notification', async () => {
    const f = fixture('approved', 'Заявка одобрена администратором');
    await f.service.reviewPayout('admin', 'payout', {
      status: 'approved',
      reason: 'Реквизиты дополнительно проверены',
    });
    expect(f.tx.partnerPayoutEvent.create).toHaveBeenCalledOnce();
    expect(f.tx.partnerNotification.create).not.toHaveBeenCalled();
  });
});
