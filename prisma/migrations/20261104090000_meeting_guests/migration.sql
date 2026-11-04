-- Backfill existing rows and let older API instances create meetings during rollout.
ALTER TABLE "meetings" ADD COLUMN "guest_invite_token" TEXT NOT NULL DEFAULT (gen_random_uuid())::text;
CREATE UNIQUE INDEX "meetings_guest_invite_token_key" ON "meetings"("guest_invite_token");

CREATE TABLE "meeting_guests" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "session_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "admitted" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMP(3),
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "raised_hand" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "meeting_guests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "meeting_guests_meeting_id_session_hash_key" ON "meeting_guests"("meeting_id", "session_hash");
ALTER TABLE "meeting_guests" ADD CONSTRAINT "meeting_guests_meeting_id_fkey"
FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
