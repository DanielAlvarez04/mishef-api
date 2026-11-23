-- CreateEnum
CREATE TYPE "AiProposalStatus" AS ENUM ('PROPOSED', 'APPLIED', 'DISMISSED');

-- DropIndex
DROP INDEX "SupplierProduct_normalizedName_trgm_idx";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "marketingCopy" TEXT,
ADD COLUMN     "translations" JSONB;

-- CreateTable
CREATE TABLE "AiCatalogProposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "status" "AiProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "createdBy" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCatalogProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSuggestionEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "accepted" BOOLEAN NOT NULL,
    "adjustments" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSuggestionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCatalogProposal_organizationId_status_createdAt_idx" ON "AiCatalogProposal"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiCatalogProposal_itemId_hash_key" ON "AiCatalogProposal"("itemId", "hash");

-- CreateIndex
CREATE INDEX "AiSuggestionEvent_organizationId_kind_createdAt_idx" ON "AiSuggestionEvent"("organizationId", "kind", "createdAt");

-- AddForeignKey
ALTER TABLE "AiCatalogProposal" ADD CONSTRAINT "AiCatalogProposal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCatalogProposal" ADD CONSTRAINT "AiCatalogProposal_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestionEvent" ADD CONSTRAINT "AiSuggestionEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
