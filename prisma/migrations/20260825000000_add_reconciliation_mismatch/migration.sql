-- Migration: Add ReconciliationMismatch table for contract-sync reconciliation worker.
-- Mismatches are append-only audit records flagged when on-chain contribution
-- state diverges from the backend DB; they are never auto-deleted.

CREATE TABLE "ReconciliationMismatch" (
    "id"            TEXT NOT NULL,
    "groupId"       TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "onChainAmount" DECIMAL(65,30) NOT NULL,
    "dbAmount"      DECIMAL(65,30) NOT NULL,
    "detectedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt"    TIMESTAMP(3),
    "resolvedBy"    TEXT,

    CONSTRAINT "ReconciliationMismatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReconciliationMismatch_groupId_idx"    ON "ReconciliationMismatch"("groupId");
CREATE INDEX "ReconciliationMismatch_userId_idx"     ON "ReconciliationMismatch"("userId");
CREATE INDEX "ReconciliationMismatch_detectedAt_idx" ON "ReconciliationMismatch"("detectedAt");
CREATE INDEX "ReconciliationMismatch_resolvedAt_idx" ON "ReconciliationMismatch"("resolvedAt");
