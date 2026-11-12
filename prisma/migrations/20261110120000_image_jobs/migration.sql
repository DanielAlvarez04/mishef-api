-- CreateEnum
CREATE TYPE "ImageJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageJobTarget" AS ENUM ('CATALOG_ENTRY', 'VARIANT');

-- CreateTable
CREATE TABLE "ImageJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "target" "ImageJobTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "itemId" TEXT,
    "imageName" TEXT,
    "folder" TEXT NOT NULL,
    "tempKey" TEXT NOT NULL,
    "status" "ImageJobStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ImageJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImageJob_organizationId_status_idx" ON "ImageJob"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ImageJob_status_createdAt_idx" ON "ImageJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ImageJob" ADD CONSTRAINT "ImageJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
