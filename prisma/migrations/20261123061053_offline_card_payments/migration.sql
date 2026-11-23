-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "createdOfflineAt" TIMESTAMP(3),
ADD COLUMN     "offlineDeviceId" TEXT,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Payment_organizationId_reviewRequired_status_idx" ON "Payment"("organizationId", "reviewRequired", "status");

-- CreateIndex
CREATE INDEX "Payment_sessionId_reviewRequired_idx" ON "Payment"("sessionId", "reviewRequired");
