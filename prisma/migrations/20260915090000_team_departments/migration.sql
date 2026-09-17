ALTER TABLE "users" ADD COLUMN "name" TEXT;

CREATE TYPE "DepartmentRole" AS ENUM ('CHIEF', 'ADMIN', 'WORKER');

CREATE TABLE "departments" (
  "id" TEXT NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "departments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "departments_workspace_id_idx" ON "departments"("workspace_id");

CREATE TABLE "department_members" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "department_id" TEXT NOT NULL,
  "role" "DepartmentRole" NOT NULL DEFAULT 'WORKER',
  CONSTRAINT "department_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "department_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "department_members_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "department_members_department_id_user_id_key" ON "department_members"("department_id", "user_id");
CREATE INDEX "department_members_user_id_idx" ON "department_members"("user_id");
-- A department has at most one chief, including concurrent requests.
CREATE UNIQUE INDEX "department_members_one_chief" ON "department_members"("department_id") WHERE "role" = 'CHIEF';

CREATE TABLE "team_invitations" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "department_id" TEXT NOT NULL,
  "role" "DepartmentRole" NOT NULL,
  "invited_by_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "team_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "team_invitations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "team_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "team_invitations_token_hash_key" ON "team_invitations"("token_hash");
CREATE INDEX "team_invitations_department_id_email_idx" ON "team_invitations"("department_id", "email");
