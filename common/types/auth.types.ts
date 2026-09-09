export type ConfirmationPurpose = 'login' | 'register';

export interface ConfirmationCodeRecord {
  codeHash: string;
  purpose: ConfirmationPurpose;
  attempts: number;
  createdAt: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
}
