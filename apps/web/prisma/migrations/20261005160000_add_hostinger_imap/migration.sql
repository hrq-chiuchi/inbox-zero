CREATE TABLE "ImapConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 465,
    "pollCursor" TEXT,
    CONSTRAINT "ImapConnection_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ImapMessage" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "folderPath" TEXT NOT NULL,
    "uidValidity" TEXT NOT NULL,
    "uid" BIGINT NOT NULL,
    "rfcMessageId" TEXT,
    "threadId" TEXT NOT NULL,
    "flags" TEXT[],
    "internalDate" TIMESTAMP(3) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ImapMessage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ImapSyncSnapshot" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "folderPath" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImapSyncSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImapConnection_emailAccountId_key" ON "ImapConnection"("emailAccountId");
CREATE UNIQUE INDEX "ImapMessage_emailAccountId_folderPath_uidValidity_uid_key" ON "ImapMessage"("emailAccountId", "folderPath", "uidValidity", "uid");
CREATE INDEX "ImapMessage_emailAccountId_threadId_deleted_idx" ON "ImapMessage"("emailAccountId", "threadId", "deleted");
CREATE INDEX "ImapMessage_emailAccountId_rfcMessageId_idx" ON "ImapMessage"("emailAccountId", "rfcMessageId");
CREATE INDEX "ImapSyncSnapshot_expiresAt_idx" ON "ImapSyncSnapshot"("expiresAt");
CREATE INDEX "ImapSyncSnapshot_emailAccountId_folderPath_idx" ON "ImapSyncSnapshot"("emailAccountId", "folderPath");
ALTER TABLE "ImapConnection" ADD CONSTRAINT "ImapConnection_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImapMessage" ADD CONSTRAINT "ImapMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ImapSyncSnapshot" ADD CONSTRAINT "ImapSyncSnapshot_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "ImapLabel" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "color" JSONB,
    "labelListVisibility" TEXT,
    "messageListVisibility" TEXT,
    CONSTRAINT "ImapLabel_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ImapLabel_emailAccountId_keyword_key" ON "ImapLabel"("emailAccountId", "keyword");
CREATE UNIQUE INDEX "ImapLabel_emailAccountId_name_key" ON "ImapLabel"("emailAccountId", "name");
ALTER TABLE "ImapLabel" ADD CONSTRAINT "ImapLabel_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
