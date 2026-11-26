-- AlterTable
ALTER TABLE "KitchenTicket" ADD COLUMN "expoAt" TIMESTAMP(3),
ADD COLUMN "expoValidatedById" TEXT,
ADD COLUMN "expoValidatedByName" TEXT;

-- CreateTable
CREATE TABLE "KitchenTicketHistory" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "previousStatus" "KitchenTicketStatus",
    "newStatus" "KitchenTicketStatus" NOT NULL,
    "changedById" TEXT,
    "changedByName" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "KitchenTicketHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KitchenTicketHistory_ticketId_changedAt_idx" ON "KitchenTicketHistory"("ticketId", "changedAt");

-- AddForeignKey
ALTER TABLE "KitchenTicketHistory" ADD CONSTRAINT "KitchenTicketHistory_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "KitchenTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;