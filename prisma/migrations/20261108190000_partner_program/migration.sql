-- CreateTable
CREATE TABLE "partners" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT NOT NULL DEFAULT '',
    "channel" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payout_details" JSONB,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_referrals" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payments" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "order_id" TEXT,
    "referral_id" TEXT NOT NULL,
    "amount_kopecks" INTEGER NOT NULL,
    "refunded_kopecks" INTEGER NOT NULL DEFAULT 0,
    "commission_kopecks" INTEGER NOT NULL,
    "terms_id" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_ledger_entries" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "referral_id" TEXT,
    "payment_id" TEXT,
    "kind" TEXT NOT NULL,
    "amount_kopecks" INTEGER NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "operation_key" TEXT NOT NULL,

    CONSTRAINT "partner_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payouts" (
    "id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "amount_kopecks" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_note" TEXT NOT NULL DEFAULT '',
    "paid_at" TIMESTAMP(3),
    "paid_kopecks" INTEGER,
    "details" JSONB NOT NULL,

    CONSTRAINT "partner_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_payout_events" (
    "id" TEXT NOT NULL,
    "payout_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "amount_kopecks" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_payout_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_terms" (
    "id" TEXT NOT NULL,
    "commission_bps" INTEGER NOT NULL,
    "eligible_months" INTEGER NOT NULL,
    "hold_days" INTEGER NOT NULL,
    "minimum_payout_kopecks" INTEGER NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" TEXT NOT NULL,

    CONSTRAINT "partner_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_operations" (
    "id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "result_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_admins" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_admin_sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partners_user_id_key" ON "partners"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "partners_code_key" ON "partners"("code");

-- CreateIndex
CREATE UNIQUE INDEX "partner_referrals_referred_user_id_key" ON "partner_referrals"("referred_user_id");

-- CreateIndex
CREATE INDEX "partner_referrals_partner_id_registered_at_idx" ON "partner_referrals"("partner_id", "registered_at");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payments_external_id_key" ON "partner_payments"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "partner_payments_order_id_key" ON "partner_payments"("order_id");

-- CreateIndex
CREATE INDEX "partner_payments_referral_id_paid_at_idx" ON "partner_payments"("referral_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "partner_ledger_entries_operation_key_key" ON "partner_ledger_entries"("operation_key");

-- CreateIndex
CREATE INDEX "partner_ledger_entries_partner_id_available_at_idx" ON "partner_ledger_entries"("partner_id", "available_at");

-- CreateIndex
CREATE INDEX "partner_ledger_entries_payment_id_idx" ON "partner_ledger_entries"("payment_id");

-- CreateIndex
CREATE INDEX "partner_payouts_partner_id_status_idx" ON "partner_payouts"("partner_id", "status");

-- CreateIndex
CREATE INDEX "partner_payout_events_payout_id_created_at_idx" ON "partner_payout_events"("payout_id", "created_at");

-- CreateIndex
CREATE INDEX "partner_terms_effective_at_idx" ON "partner_terms"("effective_at");

-- CreateIndex
CREATE UNIQUE INDEX "partner_operations_request_key_key" ON "partner_operations"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "partner_admins_login_key" ON "partner_admins"("login");

-- CreateIndex
CREATE UNIQUE INDEX "partner_admin_sessions_token_hash_key" ON "partner_admin_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "partner_admin_sessions_admin_id_idx" ON "partner_admin_sessions"("admin_id");

-- CreateIndex
CREATE INDEX "partner_admin_sessions_expires_at_idx" ON "partner_admin_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "partners" ADD CONSTRAINT "partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_referrals" ADD CONSTRAINT "partner_referrals_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payments" ADD CONSTRAINT "partner_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "payment_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payments" ADD CONSTRAINT "partner_payments_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "partner_referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payments" ADD CONSTRAINT "partner_payments_terms_id_fkey" FOREIGN KEY ("terms_id") REFERENCES "partner_terms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_ledger_entries" ADD CONSTRAINT "partner_ledger_entries_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_ledger_entries" ADD CONSTRAINT "partner_ledger_entries_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "partner_referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_ledger_entries" ADD CONSTRAINT "partner_ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "partner_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payouts_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_payout_events" ADD CONSTRAINT "partner_payout_events_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "partner_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_admin_sessions" ADD CONSTRAINT "partner_admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "partner_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Store money as integer kopecks and enforce the same invariants for every writer.
ALTER TABLE "partner_payments" ADD CONSTRAINT "partner_payment_amounts_valid" CHECK (
  amount_kopecks > 0 AND refunded_kopecks BETWEEN 0 AND amount_kopecks
  AND commission_kopecks BETWEEN 0 AND amount_kopecks
);
ALTER TABLE "partner_ledger_entries" ADD CONSTRAINT "partner_ledger_kind_valid" CHECK (
  (kind = 'commission' AND amount_kopecks > 0 AND payment_id IS NOT NULL)
  OR (kind = 'refund' AND amount_kopecks < 0 AND payment_id IS NOT NULL)
  OR (kind = 'adjustment' AND amount_kopecks <> 0)
);
CREATE UNIQUE INDEX "partner_payment_single_commission" ON "partner_ledger_entries" (payment_id) WHERE kind = 'commission';
ALTER TABLE "partner_payouts" ADD CONSTRAINT "partner_payout_valid" CHECK (
  amount_kopecks > 0 AND status IN ('new', 'review', 'approved', 'paid', 'rejected')
  AND ((status = 'paid' AND paid_kopecks > 0 AND paid_kopecks <= amount_kopecks AND paid_at IS NOT NULL)
    OR (status <> 'paid' AND paid_kopecks IS NULL AND paid_at IS NULL))
);
ALTER TABLE "partner_terms" ADD CONSTRAINT "partner_terms_valid" CHECK (
  commission_bps BETWEEN 0 AND 10000 AND eligible_months BETWEEN 1 AND 120
  AND hold_days BETWEEN 0 AND 365 AND minimum_payout_kopecks > 0
);

-- Initial configurable conditions; changes create a new terms version.
INSERT INTO "partner_terms" (id, commission_bps, eligible_months, hold_days, minimum_payout_kopecks, effective_at, actor_id)
VALUES ('partner_terms_initial', 2000, 12, 14, 500000, '2000-01-01T00:00:00Z', 'migration');

CREATE FUNCTION partner_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Partner financial history is append-only';
END;
$$;
CREATE TRIGGER partner_ledger_append_only BEFORE UPDATE OR DELETE ON "partner_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION partner_reject_history_change();
CREATE TRIGGER partner_operations_append_only BEFORE UPDATE OR DELETE ON "partner_operations"
FOR EACH ROW EXECUTE FUNCTION partner_reject_history_change();
CREATE TRIGGER partner_terms_append_only BEFORE UPDATE OR DELETE ON "partner_terms"
FOR EACH ROW EXECUTE FUNCTION partner_reject_history_change();
CREATE TRIGGER partner_payout_events_append_only BEFORE UPDATE OR DELETE ON "partner_payout_events"
FOR EACH ROW EXECUTE FUNCTION partner_reject_history_change();
