import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class OAuthStartDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) codeChallenge!: string;
  @IsOptional() @IsString() @MaxLength(1000) returnTo?: string;
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_-]{16,64}$/) partnerCode?: string;
  @IsOptional() @IsString() @Matches(/^[a-zA-Z0-9_-]{16,64}$/) referralCode?: string;
}
export class OAuthExchangeDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) ticket!: string;
  @IsString() @Matches(/^[A-Za-z0-9._~-]{43,128}$/) codeVerifier!: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @Matches(/^\d{6}$/) code?: string;
}
