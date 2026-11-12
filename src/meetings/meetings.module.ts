import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingCoreModule } from '../billing/billing-core.module.js';
import { TeamModule } from '../team/team.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { GigachatModule } from '../gigachat/gigachat.module.js';
import {
  MeetingsController,
  MeetingEventsController,
  SharedMeetingRecordingsController,
} from './meetings.controller.js';
import { MeetingsService } from './meetings.service.js';
import { CallsClient } from './calls.client.js';
import { MeetingsWorker } from './meetings.worker.js';
import { GuestMeetingsController } from './guest-meetings.controller.js';
import { GuestMeetingsService } from './guest-meetings.service.js';
@Module({
  imports: [
    AuthModule,
    BillingCoreModule,
    TeamModule,
    TasksModule,
    GigachatModule,
  ],
  controllers: [
    MeetingsController,
    MeetingEventsController,
    SharedMeetingRecordingsController,
    GuestMeetingsController,
  ],
  providers: [
    MeetingsService,
    CallsClient,
    MeetingsWorker,
    GuestMeetingsService,
  ],
})
export class MeetingsModule {}
