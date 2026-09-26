CREATE TYPE "NotificationEmailStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');
ALTER TABLE "notifications"
  ADD COLUMN "email_status" "NotificationEmailStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "email_sent_at" TIMESTAMP(3);
CREATE INDEX "notifications_email_status_id_idx" ON "notifications"("email_status", "id");
