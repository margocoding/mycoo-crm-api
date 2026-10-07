import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const meetingKinds = [
  'operations',
  'standup',
  'one-on-one',
  'strategy',
  'problem',
  'decision',
  'project',
  'department',
  'leaders',
  'other',
];
export class MeetingParticipantDto {
  @IsString() @Length(1, 128) personId!: string;
  @IsIn(['host', 'cohost', 'participant']) role!: string;
}
export class MeetingDto {
  @IsString() @Length(1, 120) title!: string;
  @IsIn(meetingKinds) kind!: string;
  @IsString() @Length(1, 1000) objective!: string;
  @IsDateString() startsAt!: string;
  @IsInt() @Min(5) @Max(480) duration!: number;
  @IsString() @Length(1, 128) departmentId!: string;
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique((p: MeetingParticipantDto) => p.personId)
  @ValidateNested({ each: true })
  @Type(() => MeetingParticipantDto)
  participants!: MeetingParticipantDto[];
  @IsString() @MaxLength(10000) agenda!: string;
  @IsBoolean() waitingRoom!: boolean;
  @IsBoolean() muteOnEntry!: boolean;
  @IsBoolean() allowScreenShare!: boolean;
  @IsOptional() @IsString() @Length(1, 128) previousId?: string;
}
export class MeetingActionDto {
  @IsIn([
    'start',
    'end',
    'cancel',
    'lock',
    'unlock',
    'record',
    'stop-record',
    'admit',
    'remove',
    'mute',
    'cohost',
    'participant',
    'raise',
    'lower',
  ])
  action!: string;
  @IsOptional() @IsString() @Length(1, 128) personId?: string;
}
export class TranscriptDto {
  @IsString() @Length(1, 250000) text!: string;
}
export class NotesDto {
  @IsString() @MaxLength(10000) notes!: string;
}
export class ProtocolTaskDto {
  @IsString() @Length(1, 200) title!: string;
  @IsDateString({ strict: true }) startDate!: string;
  @IsDateString({ strict: true }) dueDate!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  assigneeIds!: string[];
  @IsIn(['low', 'medium', 'high']) priority!: 'low' | 'medium' | 'high';
  @IsString() @Length(1, 3000) successCriteria!: string;
}
export class PublishProtocolDto {
  @IsInt() @Min(1) revision!: number;
  @IsString() @Length(1, 10000) summary!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(2000, { each: true })
  decisions!: string[];
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProtocolTaskDto)
  tasks!: ProtocolTaskDto[];
}
