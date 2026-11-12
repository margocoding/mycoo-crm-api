import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service.js';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn().mockResolvedValue({ accepted: ['partner@example.test'] }) }));
vi.mock('nodemailer', () => ({ createTransport: () => ({ sendMail }) }));

describe('partner email content', () => {
  it('uses the partner cabinet, stable message identity and escaped user-provided rejection reason', async () => {
    const service = new MailService(new ConfigService({ SMTP_HOST: 'smtp.example.test', APP_URL: 'https://mycoo.example.test' }));
    await service.sendPartnerNotification('partner@example.test', 'event-notice', 'Заявка отклонена', '<img src=x onerror=alert(1)>');
    const email = sendMail.mock.calls.at(-1)![0];
    expect(email.to).toBe('partner@example.test');
    expect(email.messageId).toBe('<partner-notification.event-notice@mycoo.io>');
    expect(email.text).toContain('https://mycoo.example.test/partner/account/notifications');
    expect(email.html).toContain('&lt;img');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).not.toContain('/dashboard');
  });
  it('does not report successful delivery if SMTP rejects the recipient', async () => {
    const service = new MailService(new ConfigService({ SMTP_HOST: 'smtp.example.test', APP_URL: 'https://mycoo.example.test' }));
    sendMail.mockResolvedValueOnce({ accepted: [] });
    await expect(service.sendPartnerNotification('partner@example.test', 'id', 'Выплата', 'Текст')).rejects.toThrow('not accepted');
  });
});
