ALTER TABLE "tasks" ADD COLUMN "repeat_days" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "tasks" ADD COLUMN "next_repeat_at" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "repeat_source_id" TEXT;
ALTER TABLE "tasks" ADD COLUMN "repeat_date" DATE;
CREATE INDEX "tasks_next_repeat_at_idx" ON "tasks"("next_repeat_at");
CREATE UNIQUE INDEX "tasks_repeat_source_id_repeat_date_key" ON "tasks"("repeat_source_id", "repeat_date");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_source_id_fkey" FOREIGN KEY ("repeat_source_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
