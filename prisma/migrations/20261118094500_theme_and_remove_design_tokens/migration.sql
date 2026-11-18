-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "theme" TEXT NOT NULL DEFAULT 'default';

-- DropTable
DROP TABLE "DesignTokens";
