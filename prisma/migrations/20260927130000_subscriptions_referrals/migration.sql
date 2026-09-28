-- CreateEnum
CREATE TYPE "SubscriptionKind" AS ENUM ('TRIAL', 'PAID');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('START', 'MISSION', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pending_referral_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "referral_code" TEXT,
ADD COLUMN     "trial_started_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "kind" "SubscriptionKind" NOT NULL DEFAULT 'PAID',
ADD COLUMN     "period" "BillingPeriod",
ADD COLUMN     "plan" "SubscriptionPlan";

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "bonus_days" INTEGER NOT NULL DEFAULT 30,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "period" "BillingPeriod" NOT NULL,
    "amount_kopecks" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "idempotency_key" TEXT NOT NULL,
    "provider_payment_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_user_id_key" ON "referrals"("referred_user_id");

-- CreateIndex
CREATE INDEX "referrals_inviter_id_idx" ON "referrals"("inviter_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_provider_payment_id_key" ON "payment_orders"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_user_id_idempotency_key_key" ON "payment_orders"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_active_until_idx" ON "subscriptions"("user_id", "active_until");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve the earliest existing trial; creating another workspace must not restart it.
UPDATE "users" u SET "trial_started_at" = source.started_at
FROM (
    SELECT owner_id, MIN(COALESCE(trial_started_at, created_at)) AS started_at
    FROM workspaces WHERE trial_started_at IS NOT NULL OR diagnostics_complete = true
    GROUP BY owner_id
) source WHERE u.id = source.owner_id;

INSERT INTO subscriptions (id, user_id, active_until, kind, created_at, updated_at)
SELECT 'trial-' || u.id, u.id, u.trial_started_at + INTERVAL '10 days', 'TRIAL', u.trial_started_at, CURRENT_TIMESTAMP
FROM users u WHERE u.trial_started_at IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id);

UPDATE users u SET trial_started_at = s.started_at
FROM (SELECT user_id, MIN(created_at) AS started_at FROM subscriptions GROUP BY user_id) s
WHERE u.id = s.user_id AND u.trial_started_at IS NULL;

ALTER TABLE referrals ADD CONSTRAINT referrals_no_self CHECK (inviter_id <> referred_user_id);
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_positive_amount CHECK (amount_kopecks > 0);
