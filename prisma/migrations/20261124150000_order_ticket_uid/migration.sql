-- Folio de reclamos: AAAAMMDD + consecutivo diario de 3 dígitos.
ALTER TABLE "Order" ADD COLUMN     "ticketUid" TEXT;

CREATE INDEX "Order_organizationId_ticketUid_idx" ON "Order"("organizationId", "ticketUid");

CREATE UNIQUE INDEX "Order_branchId_ticketUid_key" ON "Order"("branchId", "ticketUid");
