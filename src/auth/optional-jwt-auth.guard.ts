import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@Injectable()
export class OptionalJwtAuthGuard extends JwtAuthGuard {
  constructor(jwt: JwtService) { super(jwt); }
  async canActivate(context: ExecutionContext) {
    return context.switchToHttp().getRequest().headers.authorization
      ? super.canActivate(context) : true;
  }
}
