BEGIN;

ALTER TABLE "tasks" ADD COLUMN "workspace_id" TEXT, ADD COLUMN "start_date" DATE;
UPDATE "tasks" t SET "workspace_id" = d."workspace_id", "start_date" = t."due_date"
FROM "departments" d WHERE d."id" = t."department_id";
ALTER TABLE "tasks" ALTER COLUMN "workspace_id" SET NOT NULL, ALTER COLUMN "start_date" SET NOT NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_date_range_check" CHECK ("start_date" <= "due_date");

CREATE TABLE "task_departments" (
  "task_id" TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  CONSTRAINT "task_departments_pkey" PRIMARY KEY ("task_id", "department_id"),
  CONSTRAINT "task_departments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "task_departments" ("task_id", "department_id") SELECT "id", "department_id" FROM "tasks";
CREATE INDEX "task_departments_department_id_idx" ON "task_departments"("department_id");

ALTER TABLE "task_assignees" ADD COLUMN "department_id" TEXT;
UPDATE "task_assignees" a SET "department_id" = t."department_id" FROM "tasks" t WHERE t."id" = a."task_id";
ALTER TABLE "task_assignees" ALTER COLUMN "department_id" SET NOT NULL;
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
DROP INDEX "task_assignees_task_id_email_key";
CREATE UNIQUE INDEX "task_assignees_task_id_department_id_email_key" ON "task_assignees"("task_id", "department_id", "email");
CREATE INDEX "task_assignees_department_id_idx" ON "task_assignees"("department_id");

ALTER TABLE "tasks" DROP CONSTRAINT "tasks_department_id_fkey";
DROP INDEX "tasks_department_id_created_at_idx";
ALTER TABLE "tasks" DROP COLUMN "department_id";
CREATE INDEX "tasks_workspace_id_created_at_idx" ON "tasks"("workspace_id", "created_at");

-- Ownership is independent of department leadership, including existing workspaces.
UPDATE "department_members" m SET "role" = 'ADMIN'
FROM "departments" d JOIN "workspaces" w ON w."id" = d."workspace_id"
WHERE m."department_id" = d."id" AND m."user_id" = w."owner_id" AND m."role" = 'CHIEF';
UPDATE "workspace_members" m SET "role" = 'OWNER'
FROM "workspaces" w WHERE m."workspace_id" = w."id" AND m."user_id" = w."owner_id";

COMMIT;
