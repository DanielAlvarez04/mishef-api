-- CreateEnum
CREATE TYPE "AiAnomalyReviewStatus" AS ENUM ('ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "AiAnomalyReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "status" "AiAnomalyReviewStatus" NOT NULL,
    "userId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAnomalyReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAnomalyReview_organizationId_findingKey_key" ON "AiAnomalyReview"("organizationId", "findingKey");

-- CreateIndex
CREATE INDEX "AiAnomalyReview_organizationId_status_idx" ON "AiAnomalyReview"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "AiAnomalyReview" ADD CONSTRAINT "AiAnomalyReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
