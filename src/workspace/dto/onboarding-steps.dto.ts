import { PickType } from '@nestjs/swagger';
import { CompleteOnboardingDto } from './complete-onboarding.dto.js';

export class CompanyStepDto extends PickType(CompleteOnboardingDto, [
  'company',
  'industry',
  'industryOther',
  'site',
  'employees',
  'managers',
  'revenue',
  'stage',
] as const) {}

export class OwnerStepDto extends PickType(CompleteOnboardingDto, [
  'ownerName',
  'ownerRole',
  'roleOther',
  'ownerEmail',
] as const) {}

export class GoalsStepDto extends PickType(CompleteOnboardingDto, [
  'goal',
  'problem',
  'priority1',
  'priority2',
  'priority3',
] as const) {}
