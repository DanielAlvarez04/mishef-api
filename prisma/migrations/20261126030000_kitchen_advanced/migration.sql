-- CreateEnum
CREATE TYPE "KitchenMode" AS ENUM ('GENERAL', 'ADVANCED');

-- CreateEnum
CREATE TYPE "KitchenStationType" AS ENUM ('GARDE_MANGER', 'ENTREMETIER', 'SAUCIER', 'GRILL', 'FRY', 'FISH', 'PASTRY', 'BUTCHERY', 'EXPO', 'CUSTOM');

-- CreateEnum
CREATE TYPE "KitchenPositionLevel" AS ENUM ('MANAGEMENT', 'CHEF_DE_PARTIE', 'COOK', 'ASSISTANT', 'EXPO');

-- CreateEnum
CREATE TYPE "KitchenTicketStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "KitchenItemStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED', 'VOID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderRoundStatus" ADD VALUE 'HELD';
ALTER TYPE "OrderRoundStatus" ADD VALUE 'FIRED';
ALTER TYPE "OrderRoundStatus" ADD VALUE 'PICKED_UP';

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "kitchenMode" "KitchenMode" NOT NULL DEFAULT 'GENERAL';

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "kitchenPositionId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "stationId" TEXT;

-- AlterTable
ALTER TABLE "OrderRound" ADD COLUMN     "courseId" TEXT,
ADD COLUMN     "firedAt" TIMESTAMP(3),
ADD COLUMN     "heldAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "defaultStationId" TEXT;

-- CreateTable
CREATE TABLE "KitchenStation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "KitchenStationType" NOT NULL DEFAULT 'CUSTOM',
    "color" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenStation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenPosition" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "level" "KitchenPositionLevel" NOT NULL DEFAULT 'COOK',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystemPreset" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KitchenAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenStationRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "stationId" TEXT NOT NULL,
    "itemId" TEXT,
    "categoryId" TEXT,
    "menuId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenStationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenCourse" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitchenCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenTicket" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "orderRoundId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "status" "KitchenTicketStatus" NOT NULL DEFAULT 'PENDING',
    "assignedMembershipId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "KitchenTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitchenTicketItem" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "status" "KitchenItemStatus" NOT NULL DEFAULT 'PENDING',
    "voidReason" TEXT,
    "refiredFromId" TEXT,

    CONSTRAINT "KitchenTicketItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KitchenStation_organizationId_isActive_idx" ON "KitchenStation"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "KitchenStation_branchId_isActive_idx" ON "KitchenStation"("branchId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenStation_organizationId_branchId_code_key" ON "KitchenStation"("organizationId", "branchId", "code");

-- CreateIndex
CREATE INDEX "KitchenPosition_organizationId_isActive_idx" ON "KitchenPosition"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenPosition_organizationId_code_key" ON "KitchenPosition"("organizationId", "code");

-- CreateIndex
CREATE INDEX "KitchenAssignment_organizationId_idx" ON "KitchenAssignment"("organizationId");

-- CreateIndex
CREATE INDEX "KitchenAssignment_stationId_idx" ON "KitchenAssignment"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenAssignment_membershipId_stationId_key" ON "KitchenAssignment"("membershipId", "stationId");

-- CreateIndex
CREATE INDEX "KitchenStationRule_organizationId_itemId_idx" ON "KitchenStationRule"("organizationId", "itemId");

-- CreateIndex
CREATE INDEX "KitchenStationRule_organizationId_categoryId_idx" ON "KitchenStationRule"("organizationId", "categoryId");

-- CreateIndex
CREATE INDEX "KitchenStationRule_organizationId_menuId_idx" ON "KitchenStationRule"("organizationId", "menuId");

-- CreateIndex
CREATE INDEX "KitchenStationRule_stationId_idx" ON "KitchenStationRule"("stationId");

-- CreateIndex
CREATE INDEX "KitchenCourse_organizationId_isActive_idx" ON "KitchenCourse"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenCourse_organizationId_name_key" ON "KitchenCourse"("organizationId", "name");

-- CreateIndex
CREATE INDEX "KitchenTicket_organizationId_status_createdAt_idx" ON "KitchenTicket"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KitchenTicket_branchId_status_createdAt_idx" ON "KitchenTicket"("branchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "KitchenTicket_stationId_status_idx" ON "KitchenTicket"("stationId", "status");

-- CreateIndex
CREATE INDEX "KitchenTicket_assignedMembershipId_idx" ON "KitchenTicket"("assignedMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenTicket_orderRoundId_stationId_key" ON "KitchenTicket"("orderRoundId", "stationId");

-- CreateIndex
CREATE INDEX "KitchenTicketItem_orderItemId_idx" ON "KitchenTicketItem"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenTicketItem_ticketId_orderItemId_key" ON "KitchenTicketItem"("ticketId", "orderItemId");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_kitchenPositionId_fkey" FOREIGN KEY ("kitchenPositionId") REFERENCES "KitchenPosition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_defaultStationId_fkey" FOREIGN KEY ("defaultStationId") REFERENCES "KitchenStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRound" ADD CONSTRAINT "OrderRound_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "KitchenCourse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStation" ADD CONSTRAINT "KitchenStation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStation" ADD CONSTRAINT "KitchenStation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenPosition" ADD CONSTRAINT "KitchenPosition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenAssignment" ADD CONSTRAINT "KitchenAssignment_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenAssignment" ADD CONSTRAINT "KitchenAssignment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStationRule" ADD CONSTRAINT "KitchenStationRule_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStationRule" ADD CONSTRAINT "KitchenStationRule_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStationRule" ADD CONSTRAINT "KitchenStationRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenStationRule" ADD CONSTRAINT "KitchenStationRule_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenCourse" ADD CONSTRAINT "KitchenCourse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_orderRoundId_fkey" FOREIGN KEY ("orderRoundId") REFERENCES "OrderRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicket" ADD CONSTRAINT "KitchenTicket_assignedMembershipId_fkey" FOREIGN KEY ("assignedMembershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicketItem" ADD CONSTRAINT "KitchenTicketItem_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KitchenTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitchenTicketItem" ADD CONSTRAINT "KitchenTicketItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
