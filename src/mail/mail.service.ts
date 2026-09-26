import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ConfirmationPurpose } from "../../common/types/auth.types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>("SMTP_HOST");

    if (host) {
      const user = this.config.get<string>("SMTP_USER");
      const pass = this.config.get<string>("SMTP_PASS");

      this.transporter = nodemailer.createTransport({
        host,
        port: Number(this.config.get("SMTP_PORT", 587)),
        secure: this.config.get("SMTP_SECURE", "false") === "true",
        auth:
          user && pass
            ? {
                user,
                pass,
              }
            : undefined,
      });
    } else {
      this.logger.warn("SMTP_HOST не задан. Письма отправляться не будут.");
    }
  }

  private loadTemplate(filename: string): string {
    const templatePath = path.join(__dirname, "templates", filename);
    return fs.readFileSync(templatePath, "utf-8");
  }

  get configured(): boolean { return this.transporter !== null; }

  async sendNotification(email: string, id: string, kind: 'TASK_ASSIGNED' | 'ROLE_CHANGED', company: string, message: string): Promise<void> {
    if (!this.transporter) throw new Error('SMTP is not configured');
    const link = new URL('/dashboard/notifications', this.config.get('APP_URL', 'https://mycoo.io'));
    if (!['https:', 'http:'].includes(link.protocol)) throw new Error('APP_URL must use HTTP or HTTPS');
    const title = kind === 'TASK_ASSIGNED' ? 'Вам назначена задача' : 'Ваша роль изменена';
    const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const result = await this.transporter.sendMail({
      from: this.config.get('MAIL_FROM', 'MyCOO <no-reply@mycoo.io>'), to: email,
      messageId: `<notification.${id}@mycoo.io>`, subject: `${title} — MyCOO`,
      text: `${company}\n\n${message}\n\nОткрыть уведомления: ${link.href}`,
      html: this.renderTemplate(this.loadTemplate('notification.html'), {
        title, company: escape(company), message: escape(message), link: escape(link.href),
      }),
    });
    if (!result.accepted?.length) throw new Error('Notification email was not accepted');
  }

  private renderTemplate(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || "");
  }

  async sendConfirmationCode(
    email: string,
    code: string,
    purpose: ConfirmationPurpose,
  ): Promise<void> {
    const subject =
      purpose === "login"
        ? "Код для входа в MyCOO"
        : "Код для регистрации в MyCOO";

    const ttlMinutes = Math.round(
      Number(this.config.get("CODE_TTL_SECONDS", 300)) / 60,
    );

    const purposeTitle = purpose === "login" ? "Вход в систему" : "Регистрация";

    const template = this.loadTemplate("confirm.html");
    const html = this.renderTemplate(template, {
      purposeTitle,
      code,
      ttlMinutes: String(ttlMinutes),
    });

    if (!this.transporter) {
      this.logger.warn(
        "SMTP transporter не сконфигурирован. Письмо не отправлено.",
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.config.get("MAIL_FROM", "MyCOO <no-reply@mycoo.io>"),
      to: email,
      subject,
      html,
    });
  }

  async sendInvitation(
    email: string,
    link: string,
    company: string,
    department: string,
    role: string,
    invitedBy: string,
  ): Promise<void> {
    const subject = "Приглашение в команду MyCOO";

    const template = this.loadTemplate("invite.html");
    const html = this.renderTemplate(template, {
      company,
      department,
      role,
      invitedBy,
      link,
    });

    if (!this.transporter) {
      this.logger.warn(
        "SMTP transporter не сконфигурирован. Письмо не отправлено.",
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.config.get("MAIL_FROM", "MyCOO <no-reply@mycoo.io>"),
      to: email,
      subject,
      html,
    });
  }
}
