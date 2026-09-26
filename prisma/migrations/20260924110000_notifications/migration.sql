CREATE TYPE "TaskAssigningRole" AS ENUM ('OWNER', 'CHIEF', 'ADMIN');
CREATE TYPE "NotificationKind" AS ENUM ('ROLE_CHANGED', 'TASK_ASSIGNED');
ALTER TABLE "tasks" ADD COLUMN "assigned_by_id" TEXT,
  ADD COLUMN "assigned_by_role" "TaskAssigningRole";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_by_id_fkey"
  FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "notifications" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recipient_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" "NotificationKind" NOT NULL,
  "message" TEXT NOT NULL,
  "task_id" TEXT REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "department_id" TEXT,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "notifications_workspace_id_recipient_id_created_at_id_idx"
  ON "notifications"("workspace_id", "recipient_id", "created_at", "id");
CREATE INDEX "notifications_workspace_id_recipient_id_read_at_idx"
  ON "notifications"("workspace_id", "recipient_id", "read_at");
