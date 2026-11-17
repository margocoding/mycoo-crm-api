ALTER TABLE "subscriptions" ADD COLUMN "usage_anchor_at" TIMESTAMP(3);
UPDATE "subscriptions" SET "usage_anchor_at" = "created_at" WHERE "kind" = 'PAID';
ALTER TYPE "NotificationKind" ADD VALUE 'AI_BUDGET';
ALTER TABLE "meeting_recordings" ADD COLUMN "size_bytes" BIGINT,
  ADD COLUMN "duration_seconds" INTEGER, ADD COLUMN "stop_after_at" TIMESTAMP(3),
  ADD COLUMN "speech_usage_id" TEXT;

CREATE TABLE "usage_windows" (
  "id" TEXT PRIMARY KEY, "key" TEXT NOT NULL, "owner_id" TEXT NOT NULL,
  "start_at" TIMESTAMP(3) NOT NULL, "end_at" TIMESTAMP(3),
  "warning_level" INTEGER NOT NULL DEFAULT 0, "warning_budget_rub" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "usage_windows_key_key" ON "usage_windows"("key");
CREATE INDEX "usage_windows_owner_id_start_at_idx" ON "usage_windows"("owner_id", "start_at");
CREATE TABLE "usage_entries" (
  "id" TEXT PRIMARY KEY, "operation_key" TEXT NOT NULL, "window_id" TEXT NOT NULL,
  "owner_id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL, "actor_id" TEXT,
  "source" TEXT NOT NULL, "model" TEXT, "kind" TEXT NOT NULL DEFAULT 'AI',
  "status" TEXT NOT NULL DEFAULT 'RESERVED', "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0, "audio_seconds" INTEGER NOT NULL DEFAULT 0,
  "cost_micros" BIGINT NOT NULL DEFAULT 0, "storage_bytes" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "settled_at" TIMESTAMP(3),
  CONSTRAINT "usage_entries_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "usage_windows"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "usage_entries_nonnegative" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "audio_seconds" >= 0 AND "cost_micros" >= 0 AND "storage_bytes" >= 0)
);
CREATE UNIQUE INDEX "usage_entries_operation_key_key" ON "usage_entries"("operation_key");
CREATE INDEX "usage_entries_window_id_status_kind_idx" ON "usage_entries"("window_id", "status", "kind");
CREATE INDEX "usage_entries_owner_id_kind_status_idx" ON "usage_entries"("owner_id", "kind", "status");
CREATE INDEX "usage_entries_workspace_id_actor_id_created_at_idx" ON "usage_entries"("workspace_id", "actor_id", "created_at");
