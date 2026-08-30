-- AlterTable
ALTER TABLE "SavingsGroup" ADD COLUMN     "isPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pausedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GroupMember" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "leftAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MemberExitLog" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "totalContributed" DECIMAL(65,30) NOT NULL,
    "totalReceived" DECIMAL(65,30) NOT NULL,
    "netOwed" DECIMAL(65,30) NOT NULL,
    "refundTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberExitLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberExitLog_groupId_idx" ON "MemberExitLog"("groupId");

-- CreateIndex
CREATE INDEX "MemberExitLog_userId_idx" ON "MemberExitLog"("userId");

-- AddForeignKey
ALTER TABLE "MemberExitLog" ADD CONSTRAINT "MemberExitLog_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SavingsGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
