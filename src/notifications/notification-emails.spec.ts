import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MailService } from '../mail/mail.service.js';
import { NotificationEmails } from './notification-emails.js';

function fixture(overrides = {}) {
  const item = { id: 'notice', kind: 'TASK_ASSIGNED', emailStatus: 'PENDING', recipientId: 'member', departmentId: 'dept',
    message: 'Вам назначена задача', recipient: { email: 'member@example.test' },
    workspace: { ownerId: 'owner', company: 'Компания', members: [{ userId: 'member' }] },
    task: { assignees: [{ userId: 'member' }] }, ...overrides };
  const db = { notification: { findUnique: vi.fn(async () => item), updateMany: vi.fn() },
    departmentMember: { findUnique: vi.fn(async () => ({ userId: 'member' })) } };
  const mail = { configured: false, sendNotification: vi.fn() };
  const service = new NotificationEmails(db as unknown as PrismaService, mail as unknown as MailService, {} as ConfigService);
  return { service, mail, db };
}

describe('Notification email delivery', () => {
  it('sends only to the notification recipient and records SMTP acceptance', async () => {
    const f = fixture();
    await f.service.deliver('notice');
    expect(f.mail.sendNotification).toHaveBeenCalledWith('member@example.test', 'notice', 'TASK_ASSIGNED', 'Компания', 'Вам назначена задача');
    expect(f.db.notification.updateMany).toHaveBeenCalledWith({ where: { id: 'notice', emailStatus: 'PENDING' },
      data: { emailStatus: 'SENT', emailSentAt: expect.any(Date) } });
  });
  it('does not send an already completed job twice', async () => {
    const f = fixture({ emailStatus: 'SENT' });
    await f.service.deliver('notice');
    expect(f.mail.sendNotification).not.toHaveBeenCalled();
  });
  it('keeps an SMTP failure pending for the queue retry', async () => {
    const f = fixture(); f.mail.sendNotification.mockRejectedValueOnce(new Error('SMTP offline'));
    await expect(f.service.deliver('notice')).rejects.toThrow('SMTP offline');
    expect(f.db.notification.updateMany).not.toHaveBeenCalled();
  });
  it('skips a removed workspace member', async () => {
    const f = fixture({ workspace: { ownerId: 'owner', company: 'Компания', members: [] } });
    await f.service.deliver('notice');
    expect(f.mail.sendNotification).not.toHaveBeenCalled();
    expect(f.db.notification.updateMany).toHaveBeenCalledWith({ where: { id: 'notice', emailStatus: 'PENDING' }, data: { emailStatus: 'SKIPPED' } });
  });
  it.each([null, { assignees: [] }])('skips a deleted task or cancelled assignment (%j)', async task => {
    const f = fixture({ task }); await f.service.deliver('notice');
    expect(f.mail.sendNotification).not.toHaveBeenCalled();
  });
  it('sends a role change only while the recipient still belongs to the department', async () => {
    const f = fixture({ kind: 'ROLE_CHANGED', task: null });
    await f.service.deliver('notice'); expect(f.mail.sendNotification).toHaveBeenCalledOnce();
    f.mail.sendNotification.mockClear(); f.db.departmentMember.findUnique.mockResolvedValueOnce(null as never);
    await f.service.deliver('notice'); expect(f.mail.sendNotification).not.toHaveBeenCalled();
  });
  it('leaves the outbox intact when SMTP is not configured', async () => {
    const f = fixture(); await f.service.onModuleInit();
    expect(f.db.notification.updateMany).not.toHaveBeenCalled();
    expect(f.mail.sendNotification).not.toHaveBeenCalled();
  });
});
