import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtPayload } from "../../common/types/auth.types.js";
import { AuthService } from "./auth.service.js";
import { CheckEmailDto } from "./dto/check-mail.dto.js";
import { CheckEmailRdo } from "./rdo/check-email.rdo.js";
import { RegisterUserDto } from "./dto/register-user.dto.js";
import { AuthRdo } from "./rdo/auth.rdo.js";
import { LoginUserDto } from "./dto/login-user.dto.js";
import { ResendCodeDto } from "./dto/resend-code.dto.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { UserRdo } from "./rdo/user.rdo.js";

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("check-email")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Проверить существование пользователя и отправить код подтверждения",
  })
  @ApiBody({ type: CheckEmailDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: CheckEmailRdo,
  })
  checkEmail(@Body() dto: CheckEmailDto) {
    return this.authService.checkEmail(dto);
  }

  @Post("register")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Регистрация пользователя после подтверждения кода",
  })
  @ApiBody({ type: RegisterUserDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: AuthRdo,
  })
  register(@Body() dto: RegisterUserDto) {
    return this.authService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Вход пользователя с паролем и кодом подтверждения",
  })
  @ApiBody({ type: LoginUserDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: AuthRdo,
  })
  login(@Body() dto: LoginUserDto) {
    return this.authService.login(dto);
  }

  @Post("resend-code")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Повторная отправка кода подтверждения",
  })
  @ApiBody({ type: ResendCodeDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: CheckEmailRdo,
  })
  resendCode(@Body() dto: ResendCodeDto) {
    return this.authService.resendCode(dto);
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Получить текущего пользователя по accessToken",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: UserRdo,
  })
  me(@Req() request: AuthenticatedRequest) {
    const payload = request.user;

    return this.authService.me(payload!.sub);
  }
}