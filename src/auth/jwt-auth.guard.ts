import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import { JwtPayload } from "../../common/types/auth.types.js";

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const token = this.extractToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException("Токен не передан.");
    }

    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      request.user = payload;

      return true;
    } catch {
      throw new UnauthorizedException(
        "Недействительный или истёкший токен.",
      );
    }
  }

  private extractToken(header?: string): string | undefined {
    if (!header || !header.startsWith("Bearer ")) {
      return undefined;
    }

    return header.slice(7);
  }
}