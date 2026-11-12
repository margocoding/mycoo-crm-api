ALTER TABLE "meeting_recordings"
  ADD COLUMN "stop_requested_at" TIMESTAMP(3),
  ADD COLUMN "share_token_hash" TEXT,
  ADD COLUMN "share_expires_at" TIMESTAMP(3);
UPDATE "meeting_recordings" SET "stop_requested_at" = CURRENT_TIMESTAMP WHERE "status" = 'stopping';
CREATE UNIQUE INDEX "meeting_recordings_share_token_hash_key" ON "meeting_recordings"("share_token_hash");
