-- AlterTable
ALTER TABLE "SavingsGroup" ADD COLUMN     "payoutOrder" JSONB,
ADD COLUMN     "currentPayoutIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCycles" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payoutOrderLockedAt" TIMESTAMP(3),
ADD COLUMN     "deadlineExtensionsUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutOrderLog" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "previousOrder" JSONB,
    "newOrder" JSONB NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'REORDER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutOrderLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payout_groupId_idx" ON "Payout"("groupId");

-- CreateIndex
CREATE INDEX "Payout_recipientId_idx" ON "Payout"("recipientId");

-- CreateIndex
CREATE INDEX "PayoutOrderLog_groupId_idx" ON "PayoutOrderLog"("groupId");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SavingsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutOrderLog" ADD CONSTRAINT "PayoutOrderLog_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SavingsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
