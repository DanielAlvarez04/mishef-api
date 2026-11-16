-- CreateEnum
CREATE TYPE "SplitMode" AS ENUM ('BY_GUEST', 'EQUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SplitStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TipSource" AS ENUM ('NONE', 'SUGGESTED', 'CUSTOM', 'CUSTOMER_DISPLAY');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "splitId" TEXT,
ADD COLUMN     "tipBaseAmount" DECIMAL(12,2),
ADD COLUMN     "tipPercent" DECIMAL(5,2),
ADD COLUMN     "tipSource" "TipSource" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "OrderSplit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "guestId" TEXT,
    "label" TEXT,
    "mode" "SplitMode" NOT NULL,
    "expectedAmount" DECIMAL(12,2) NOT NULL,
    "status" "SplitStatus" NOT NULL DEFAULT 'OPEN',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderSplit_orderId_status_idx" ON "OrderSplit"("orderId", "status");

-- CreateIndex
CREATE INDEX "OrderSplit_guestId_idx" ON "OrderSplit"("guestId");

-- CreateIndex
CREATE INDEX "Payment_splitId_idx" ON "Payment"("splitId");

-- AddForeignKey
ALTER TABLE "OrderSplit" ADD CONSTRAINT "OrderSplit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderSplit" ADD CONSTRAINT "OrderSplit_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "OrderGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_splitId_fkey" FOREIGN KEY ("splitId") REFERENCES "OrderSplit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
