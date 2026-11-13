-- CreateEnum
CREATE TYPE "PrepTimeSource" AS ENUM ('MANUAL', 'HISTORICAL');

-- AlterTable
ALTER TABLE "OrderRound" ADD COLUMN     "estimatedMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "kitchenPrepMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "kitchenPrepSource" "PrepTimeSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "kitchenSuggestOrder" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "prepMinutes" INTEGER;
