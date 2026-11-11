import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const trim = () => Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value);
const MAX_RUB = 21_474_836.47;

export class RegisterPartnerDto {
  @trim() @IsString() @MinLength(1) @MaxLength(120) name: string;
  @trim() @IsString() @MaxLength(150) company: string;
  @IsOptional() @trim() @IsString() @MaxLength(250) channel?: string;
  @IsOptional() @trim() @IsString() @MaxLength(500) website?: string;
}

export class PartnerDetailsDto {
  @trim() @IsString() @MinLength(2) @MaxLength(250) recipient: string;
  @IsString() @Matches(/^(?:\d{10}|\d{12})$/) taxId: string;
  @trim() @IsString() @MinLength(2) @MaxLength(250) bank: string;
  @IsString() @Matches(/^\d{20}$/) account: string;
  @IsString() @Matches(/^\d{9}$/) bic: string;
  @IsIn(['self-employed', 'entrepreneur', 'company']) legalForm: 'self-employed' | 'entrepreneur' | 'company';
}

export class PartnerIdempotencyDto {
  @IsString() @MinLength(8) @MaxLength(100) @Matches(/^[\w-]+$/) idempotencyKey: string;
}

export class RequestPartnerPayoutDto extends PartnerIdempotencyDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MAX_RUB) amount: number;
}

export class ReviewPartnerPayoutDto {
  @IsIn(['review', 'approved', 'rejected']) status: 'review' | 'approved' | 'rejected';
  @IsOptional() @trim() @IsString() @MaxLength(2000) reason?: string;
}

export class PayPartnerPayoutDto extends RequestPartnerPayoutDto {
  @IsISO8601({ strict: true }) date: string;
}

export class AdjustPartnerCommissionDto extends PartnerIdempotencyDto {
  @IsString() @MinLength(1) @MaxLength(100) partnerId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(-MAX_RUB) @Max(MAX_RUB) amount: number;
  @trim() @IsString() @MinLength(1) @MaxLength(2000) description: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) paymentId?: string;
}

export class RecordPartnerPaymentDto extends RequestPartnerPayoutDto {
  @IsString() @MinLength(1) @MaxLength(100) referralId: string;
  @trim() @IsString() @MinLength(1) @MaxLength(100) paymentId: string;
  @IsOptional() @IsISO8601({ strict: true }) date?: string;
}

export class RefundPartnerPaymentDto extends RequestPartnerPayoutDto {
  @trim() @IsString() @MinLength(1) @MaxLength(2000) reason: string;
}

export class PartnerTermsDto {
  @IsInt() @Min(0) @Max(100) commissionPercent: number;
  @IsInt() @Min(1) @Max(120) eligibleMonths: number;
  @IsInt() @Min(0) @Max(365) holdDays: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MAX_RUB) minimumPayout: number;
}

export class PartnerAdminLoginDto {
  @trim() @IsString() @MinLength(3) @MaxLength(100) login: string;
  @IsString() @MinLength(1) @MaxLength(256) password: string;
}

export class PartnerAdminCredentialsDto extends PartnerAdminLoginDto {
  @IsString() @MinLength(8) @MaxLength(256) declare password: string;
  @IsString() @MinLength(1) @MaxLength(256) currentPassword: string;
}
