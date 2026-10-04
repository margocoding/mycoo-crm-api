-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'MEETING_INVITED';
ALTER TYPE "NotificationKind" ADD VALUE 'MEETING_PROTOCOL';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "meeting_id" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "meeting_id" TEXT;

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "organizer_id" TEXT NOT NULL,
    "room_name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'operations',
    "objective" TEXT NOT NULL DEFAULT '',
    "agenda" TEXT NOT NULL DEFAULT '',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "waiting_room" BOOLEAN NOT NULL DEFAULT true,
    "mute_on_entry" BOOLEAN NOT NULL DEFAULT true,
    "allow_screen_share" BOOLEAN NOT NULL DEFAULT true,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "room_closed" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "previous_id" TEXT,
    "transcript" TEXT NOT NULL DEFAULT '',
    "transcript_source" TEXT NOT NULL DEFAULT 'recording',
    "analysis_status" TEXT NOT NULL DEFAULT 'none',
    "analysis_revision" INTEGER NOT NULL DEFAULT 0,
    "analysis" JSONB,
    "analysis_error" TEXT,
    "processing_until" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_participants" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'participant',
    "admitted" BOOLEAN NOT NULL DEFAULT false,
    "requested_at" TIMESTAMP(3),
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "raised_hand" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_recordings" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "egress_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "file_key" TEXT,
    "upload_id" TEXT,
    "speech_task_id" TEXT,
    "transcript" TEXT,
    "error" TEXT,
    "processing_until" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meetings_room_name_key" ON "meetings"("room_name");

-- CreateIndex
CREATE INDEX "meetings_workspace_id_starts_at_idx" ON "meetings"("workspace_id", "starts_at");

-- CreateIndex
CREATE INDEX "meetings_analysis_status_processing_until_idx" ON "meetings"("analysis_status", "processing_until");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_participants_meeting_id_user_id_key" ON "meeting_participants"("meeting_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_recordings_egress_id_key" ON "meeting_recordings"("egress_id");

-- CreateIndex
CREATE INDEX "meeting_recordings_status_next_attempt_at_idx" ON "meeting_recordings"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_previous_id_fkey" FOREIGN KEY ("previous_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_recordings" ADD CONSTRAINT "meeting_recordings_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
