CREATE TABLE "dashboard_snapshots" (
  "scope_key" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "department_id" TEXT REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "analysis" JSONB,
  "generated_at" TIMESTAMP(3),
  "period_start" DATE,
  "period_end" DATE,
  "processing_at" TIMESTAMP(3),
  "next_refresh_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "dashboard_snapshots_next_refresh_at_idx" ON "dashboard_snapshots"("next_refresh_at");
