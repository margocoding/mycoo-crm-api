import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { BillingGuard } from '../billing/billing.guard.js';
import { MeetingsService } from './meetings.service.js';
import { CallsClient } from './calls.client.js';
import {
  MeetingActionDto,
  MeetingDto,
  NotesDto,
  PublishProtocolDto,
  TranscriptDto,
} from './meetings.dto.js';
interface UserRequest extends Request {
  user: JwtPayload;
}
interface Params {
  workspaceId: string;
  meetingId: string;
  recordingId: string;
}

@UseGuards(JwtAuthGuard, BillingGuard)
@Controller('workspace/:workspaceId/meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}
  @Get() list(@Req() r: UserRequest, @Param() p: Params) {
    return this.meetings.list(r.user.sub, p.workspaceId);
  }
  @Post() create(
    @Req() r: UserRequest,
    @Param() p: Params,
    @Body() dto: MeetingDto,
  ) {
    return this.meetings.create(r.user.sub, p.workspaceId, dto);
  }
  @Get(':meetingId') get(@Req() r: UserRequest, @Param() p: Params) {
    return this.meetings.get(r.user.sub, p.workspaceId, p.meetingId);
  }
  @Patch(':meetingId') edit(
    @Req() r: UserRequest,
    @Param() p: Params,
    @Body() dto: MeetingDto,
  ) {
    return this.meetings.edit(r.user.sub, p.workspaceId, p.meetingId, dto);
  }
  @Post(':meetingId/join') join(@Req() r: UserRequest, @Param() p: Params) {
    return this.meetings.join(r.user.sub, p.workspaceId, p.meetingId);
  }
  @Post(':meetingId/actions') action(
    @Req() r: UserRequest,
    @Param() p: Params,
    @Body() dto: MeetingActionDto,
  ) {
    return this.meetings.action(r.user.sub, p.workspaceId, p.meetingId, dto);
  }
  @Patch(':meetingId/notes') notes(
    @Req() r: UserRequest,
    @Param() p: Params,
    @Body() dto: NotesDto,
  ) {
    return this.meetings.notes(
      r.user.sub,
      p.workspaceId,
      p.meetingId,
      dto.notes,
    );
  }
  @Post(':meetingId/transcript') transcript(
    @Req() r: UserRequest,
    @Param() p: Params,
    @Body() dto: TranscriptDto,
  ) {
    return this.meetings.transcript(
      r.user.sub,
      p.workspaceId,
      p.meetingId,
      dto.text,
    );
  }
  @Post(':meetingId/protocol/publish') publish(
    @Req() r: UserRequest,
    @Param() p: Params,
    @Body() dto: PublishProtocolDto,
  ) {
    return this.meetings.publish(r.user.sub, p.workspaceId, p.meetingId, dto);
  }
  @Post(':meetingId/prepare') prepare(
    @Req() r: UserRequest,
    @Param() p: Params,
  ) {
    return this.meetings.prepare(r.user.sub, p.workspaceId, p.meetingId);
  }
  @Post(':meetingId/recordings/:recordingId/url') recording(
    @Req() r: UserRequest,
    @Param() p: Params,
  ) {
    return this.meetings.recordingUrl(
      r.user.sub,
      p.workspaceId,
      p.meetingId,
      p.recordingId,
    );
  }
  @Post(':meetingId/recordings/:recordingId/retry') retry(
    @Req() r: UserRequest,
    @Param() p: Params,
  ) {
    return this.meetings.retryRecording(
      r.user.sub,
      p.workspaceId,
      p.meetingId,
      p.recordingId,
    );
  }
}
@Controller('meetings/events')
export class MeetingEventsController {
  constructor(
    private readonly calls: CallsClient,
    private readonly meetings: MeetingsService,
  ) {}
  @Post() event(
    @Headers('authorization') auth: string,
    @Body() event: { event?: string; room?: string; identity?: string },
  ) {
    if (!this.calls.authorized(auth)) throw new UnauthorizedException();
    return this.meetings.event(event);
  }
}
