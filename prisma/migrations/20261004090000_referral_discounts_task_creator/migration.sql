-- Existing referral days and subscriptions are preserved. Only new referrals receive discounts.
ALTER TABLE "referrals" ALTER COLUMN "bonus_days" SET DEFAULT 0;
ALTER TABLE "referrals" ADD COLUMN "discount_percent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_orders" ADD COLUMN "discount_percent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment_orders" ADD COLUMN "referral_discount_id" TEXT;
CREATE UNIQUE INDEX "payment_orders_referral_discount_id_key" ON "payment_orders"("referral_discount_id");
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_referral_discount_id_fkey" FOREIGN KEY ("referral_discount_id") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- assigned_by_id can change on reassignment, so it cannot safely backfill the original creator.
ALTER TABLE "tasks" ADD COLUMN "created_by_id" TEXT;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
