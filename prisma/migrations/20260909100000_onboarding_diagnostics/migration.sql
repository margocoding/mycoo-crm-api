ALTER TABLE "workspaces"
  ADD COLUMN "onboarding_step" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "diagnostics_analysis" JSONB,
  ADD COLUMN "diagnostics_processing_at" TIMESTAMP(3);

UPDATE "workspaces" SET "onboarding_step" = 3 WHERE "onboarding_complete" = true;
