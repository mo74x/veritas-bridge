-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('SYNCED', 'QUARANTINED_LOW_CONFIDENCE', 'QUARANTINED_SCHEMA_FAILURE', 'FAILED_DOWNSTREAM_API', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('DETERMINISTIC_FAST_PATH', 'AI_EXTRACTION_AGENT', 'HUMAN_QUARANTINE_OVERRIDE', 'SYSTEM_ROLLBACK');

-- CreateTable
CREATE TABLE "SyncAuditLedger" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sourceSystem" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "targetSystem" TEXT NOT NULL,
    "targetRecordId" TEXT,
    "status" "SyncStatus" NOT NULL,
    "actor" "ActorType" NOT NULL,
    "rawInputPayload" JSONB NOT NULL,
    "normalizedPayload" JSONB,
    "beforeState" JSONB,
    "afterState" JSONB,
    "modelVersion" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "ambiguityFlags" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "previousHash" TEXT NOT NULL,
    "currentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncAuditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionalOutbox" (
    "id" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "TransactionalOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SyncAuditLedger_idempotencyKey_key" ON "SyncAuditLedger"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SyncAuditLedger_currentHash_key" ON "SyncAuditLedger"("currentHash");

-- CreateIndex
CREATE INDEX "SyncAuditLedger_sourceRecordId_status_idx" ON "SyncAuditLedger"("sourceRecordId", "status");

-- CreateIndex
CREATE INDEX "SyncAuditLedger_status_createdAt_idx" ON "SyncAuditLedger"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionalOutbox_published_createdAt_idx" ON "TransactionalOutbox"("published", "createdAt");
