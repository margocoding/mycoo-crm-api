CREATE TYPE "PartnerPayoutFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');
ALTER TABLE "partner_terms" ADD COLUMN "payout_frequency" "PartnerPayoutFrequency" NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "partner_terms" ADD COLUMN "payout_anchor_date" DATE;
