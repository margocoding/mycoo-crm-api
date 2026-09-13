import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as nodemailer from "nodemailer";
import { ConfirmationPurpose } from "../../common/types/auth.types.js";

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

    const text = [
      `Ваш код ${purpose === "login" ? "для входа" : "для регистрации"} в MyCOO: ${code}.`,
      `Код действует ${ttlMinutes} мин.`,
      "Если вы не запрашивали код, проигнорируйте это письмо.",
    ].join(" ");

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
      text,
    });
  }
}