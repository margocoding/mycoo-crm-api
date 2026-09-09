import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { createHash, randomInt } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RedisService } from "../redis/redis.service.js";
import { MailService } from "../mail/mail.service.js";
import { CheckEmailRdo } from "./rdo/check-email.rdo.js";
import { CheckEmailDto } from "./dto/check-mail.dto.js";
import { ConfirmationCodeRecord, ConfirmationPurpose, JwtPayload } from "../../common/types/auth.types.js";
import { fillDto } from "../../common/utils/fill-dto.util.js";
import { RegisterUserDto } from "./dto/register-user.dto.js";
import { AuthRdo } from "./rdo/auth.rdo.js";
import { AUTH_REDIS_KEYS } from "../../common/constants/auth.constants.js";
import { maskEmail } from "../../common/helpers/mask-email.helper.js";
import { LoginUserDto } from "./dto/login-user.dto.js";
import { ResendCodeDto } from "./dto/resend-code.dto.js";
import { UserRdo } from "./rdo/user.rdo.js";
import { User } from "../../generated/prisma/client.js";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private get isDevelopment(): boolean {
    return this.config.get("NODE_ENV") === "development";
  }

  private get bcryptRounds(): number {
    const value = Number(this.config.get("BCRYPT_SALT_ROUNDS", 15));

    return Number.isFinite(value) && value > 0 ? value : 15;
  }

  private get codeTtlSeconds(): number {
    const value = Number(this.config.get("CODE_TTL_SECONDS", 300));

    return Number.isFinite(value) && value > 0 ? value : 300;
  }

  private get resendCooldownSeconds(): number {
    const value = Number(
      this.config.get("CODE_RESEND_COOLDOWN_SECONDS", 30),
    );

    return Number.isFinite(value) && value > 0 ? value : 30;
  }

  private get maxCodeAttempts(): number {
    const value = Number(this.config.get("CODE_MAX_ATTEMPTS", 5));

    return Number.isFinite(value) && value > 0 ? value : 5;
  }

  async checkEmail(dto: CheckEmailDto): Promise<CheckEmailRdo> {
    const email = this.normalizeEmail(dto.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    const purpose: ConfirmationPurpose = user ? "login" : "register";

    await this.sendConfirmationCode(email, purpose);

    return fillDto(CheckEmailRdo, {
      success: Boolean(user),
    });
  }

  async register(dto: RegisterUserDto): Promise<AuthRdo> {
    const email = this.normalizeEmail(dto.email);

    await this.verifyConfirmationCode(email, dto.code, "register");

    await this.redis.delete(AUTH_REDIS_KEYS.code(email));

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        "Пользователь с таким email уже зарегистрирован.",
      );
    }

    const passwordHash = await this.hashPassword(dto.password);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
      },
    });

    this.logger.log(`User registered: ${maskEmail(email)}`);

    return this.buildAuthRdo(user);
  }

  async login(dto: LoginUserDto): Promise<AuthRdo> {
    const email = this.normalizeEmail(dto.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException(
        "Неверный email, пароль или код.",
      );
    }

    await this.verifyConfirmationCode(email, dto.code, "login");

    const passwordValid = await this.comparePassword(
      dto.password,
      user.passwordHash,
    );

    if (!passwordValid) {
      const blocked = await this.registerFailedCodeAttempt(
        email,
        "login",
      );

      if (blocked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: "Слишком много попыток. Запросите новый код.",
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new UnauthorizedException(
        "Неверный email, пароль или код.",
      );
    }

    await this.redis.delete(AUTH_REDIS_KEYS.code(email));

    this.logger.log(`User logged in: ${maskEmail(email)}`);

    return this.buildAuthRdo(user);
  }

  async resendCode(dto: ResendCodeDto): Promise<CheckEmailRdo> {
    const email = this.normalizeEmail(dto.email);

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    const purpose: ConfirmationPurpose = user ? "login" : "register";

    await this.sendConfirmationCode(email, purpose);

    return fillDto(CheckEmailRdo, {
      success: Boolean(user),
    });
  }

  async me(userId: string): Promise<UserRdo> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException("Пользователь не найден.");
    }

    return this.toUserRdo(user);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private toUserRdo(user: User): UserRdo {
    return fillDto(UserRdo, {
      ...user,
      isEmailConfirmed: true,
    });
  }

  private async buildAuthRdo(user: User): Promise<AuthRdo> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
    };

    const accessToken = this.jwt.sign(payload);

    return fillDto(AuthRdo, {
      accessToken,
      user: this.toUserRdo(user),
    });
  }

  private generateCode(): string {
    if (this.isDevelopment) {
      return "111111";
    }

    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  private async sendConfirmationCode(
    email: string,
    purpose: ConfirmationPurpose,
  ): Promise<void> {
    const cooldownKey = AUTH_REDIS_KEYS.cooldown(email);

    const acquired = await this.redis.setNxEx(
      cooldownKey,
      this.resendCooldownSeconds,
    );

    if (!acquired) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Код уже отправлен. Повторная отправка будет доступна через ${this.resendCooldownSeconds} секунд.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const codeKey = AUTH_REDIS_KEYS.code(email);

    await this.redis.delete(codeKey);

    const code = this.generateCode();

    const codeHash = await bcrypt.hash(code, this.bcryptRounds);

    const record: ConfirmationCodeRecord = {
      codeHash,
      purpose,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };

    await this.redis.setJson(codeKey, record, this.codeTtlSeconds);

    await this.mail.sendConfirmationCode(email, code, purpose);

    this.logger.log(
      `Confirmation code sent: ${maskEmail(email)} purpose=${purpose}`,
    );
  }

  private async verifyConfirmationCode(
    email: string,
    code: string,
    purpose: ConfirmationPurpose,
  ): Promise<void> {
    const key = AUTH_REDIS_KEYS.code(email);

    const record = await this.redis.getJson<ConfirmationCodeRecord>(key);

    if (!record || record.purpose !== purpose) {
      throw new BadRequestException(
        "Код не найден или истёк. Запросите новый.",
      );
    }

    if (record.attempts >= this.maxCodeAttempts) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: "Слишком много попыток. Запросите новый код.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const isValid = await bcrypt.compare(code, record.codeHash);

    if (!isValid) {
      const blocked = await this.registerFailedCodeAttempt(
        email,
        purpose,
      );

      if (blocked) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: "Слишком много попыток. Запросите новый код.",
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new BadRequestException(
        "Код не совпадает. Проверьте письмо и повторите ввод.",
      );
    }
  }

  private async registerFailedCodeAttempt(
    email: string,
    purpose: ConfirmationPurpose,
  ): Promise<boolean> {
    const key = AUTH_REDIS_KEYS.code(email);

    const record = await this.redis.getJson<ConfirmationCodeRecord>(key);

    if (!record || record.purpose !== purpose) {
      return false;
    }

    const attempts = record.attempts + 1;

    const ttl = await this.redis.ttl(key);

    await this.redis.setJson(
      key,
      {
        ...record,
        attempts,
      },
      ttl > 0 ? ttl : this.codeTtlSeconds,
    );

    return attempts >= this.maxCodeAttempts;
  }

  private preparePassword(password: string): string {
    return createHash("sha256").update(password).digest("base64");
  }

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(this.preparePassword(password), this.bcryptRounds);
  }

  private async comparePassword(
    password: string,
    passwordHash: string,
  ): Promise<boolean> {
    return bcrypt.compare(this.preparePassword(password), passwordHash);
  }
}