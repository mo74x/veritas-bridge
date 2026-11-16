/*
  Warnings:

  - You are about to drop the `TransactionalOutbox` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "SyncAuditLedger" ADD COLUMN     "parentAuditId" TEXT;

-- DropTable
DROP TABLE "TransactionalOutbox";

-- CreateIndex
CREATE INDEX "SyncAuditLedger_parentAuditId_idx" ON "SyncAuditLedger"("parentAuditId");

-- AddForeignKey
ALTER TABLE "SyncAuditLedger" ADD CONSTRAINT "SyncAuditLedger_parentAuditId_fkey" FOREIGN KEY ("parentAuditId") REFERENCES "SyncAuditLedger"("id") ON DELETE SET NULL ON UPDATE CASCADE;
