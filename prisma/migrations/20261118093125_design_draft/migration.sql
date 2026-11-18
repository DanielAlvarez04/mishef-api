-- AlterTable
ALTER TABLE "DesignTokens" ADD COLUMN     "draft" JSONB,
ALTER COLUMN "tokens" DROP NOT NULL;
