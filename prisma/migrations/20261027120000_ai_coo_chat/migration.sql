-- CreateTable
CREATE TABLE "ai_coo_conversations" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "lock_token" TEXT,
    "locked_until" TIMESTAMP(3),
    "request_window_at" TIMESTAMP(3),
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_coo_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_coo_turns" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "functions_state_id" TEXT,
    "documents" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ai_coo_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_coo_documents" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "provider_file_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_coo_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_coo_conversations_workspace_id_user_id_scope_key_key" ON "ai_coo_conversations"("workspace_id", "user_id", "scope_key");

-- CreateIndex
CREATE INDEX "ai_coo_turns_conversation_id_created_at_id_idx" ON "ai_coo_turns"("conversation_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_coo_turns_conversation_id_request_id_key" ON "ai_coo_turns"("conversation_id", "request_id");

-- CreateIndex
CREATE INDEX "ai_coo_documents_conversation_id_created_at_idx" ON "ai_coo_documents"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_coo_conversations" ADD CONSTRAINT "ai_coo_conversations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_coo_conversations" ADD CONSTRAINT "ai_coo_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_coo_turns" ADD CONSTRAINT "ai_coo_turns_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_coo_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_coo_documents" ADD CONSTRAINT "ai_coo_documents_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "ai_coo_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
