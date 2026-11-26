-- DropIndex
DROP INDEX "KitchenTicket_orderRoundId_stationId_key";

-- CreateIndex
CREATE INDEX "KitchenTicket_orderRoundId_stationId_idx" ON "KitchenTicket"("orderRoundId", "stationId");