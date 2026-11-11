CREATE TABLE "partner_notifications" (
  "id" TEXT NOT NULL,
  "partner_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "email_sent_at" TIMESTAMP(3),
  "email_attempts" INTEGER NOT NULL DEFAULT 0,
  "email_next_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "email_lease" TEXT,
  "email_lease_until" TIMESTAMP(3),
  CONSTRAINT "partner_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_notifications_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "partner_notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "partner_payout_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "partner_notifications_event_id_key" ON "partner_notifications"("event_id");
CREATE INDEX "partner_notifications_partner_id_created_at_id_idx" ON "partner_notifications"("partner_id", "created_at", "id");
CREATE INDEX "partner_notifications_partner_id_read_at_idx" ON "partner_notifications"("partner_id", "read_at");
CREATE INDEX "partner_notifications_email_sent_at_email_next_at_idx" ON "partner_notifications"("email_sent_at", "email_next_at");
