import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Post,
} from '@nestjs/common';
import { GuestMeetingsService } from './guest-meetings.service.js';
import { GuestMeetingActionDto, GuestMeetingJoinDto } from './meetings.dto.js';

@Controller('meetings/join/:token')
export class GuestMeetingsController {
  constructor(private readonly guests: GuestMeetingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(
    @Param('token') token: string,
    @Headers('x-meeting-guest-key') key?: string,
  ) {
    return this.guests.get(token, key);
  }

  @Post('join')
  @Header('Cache-Control', 'no-store')
  join(@Param('token') token: string, @Body() dto: GuestMeetingJoinDto) {
    return this.guests.join(token, dto);
  }

  @Post('actions')
  @Header('Cache-Control', 'no-store')
  action(@Param('token') token: string, @Body() dto: GuestMeetingActionDto) {
    return this.guests.action(token, dto);
  }
}
