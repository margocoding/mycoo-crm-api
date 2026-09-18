CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "success_criteria" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tasks_priority_check" CHECK ("priority" IN ('low', 'medium', 'high')),
    CONSTRAINT "tasks_status_check" CHECK ("status" IN ('backlog', 'in-progress', 'review', 'done'))
);

CREATE TABLE "task_assignees" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "user_id" TEXT,
    CONSTRAINT "task_assignees_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tasks_department_id_created_at_idx" ON "tasks"("department_id", "created_at");
CREATE UNIQUE INDEX "task_assignees_task_id_email_key" ON "task_assignees"("task_id", "email");
CREATE INDEX "task_assignees_user_id_idx" ON "task_assignees"("user_id");
CREATE INDEX "task_assignees_email_idx" ON "task_assignees"("email");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignees" ADD CONSTRAINT "task_assignees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
