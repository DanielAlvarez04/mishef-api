-- CreateIndex
CREATE INDEX "Order_organizationId_createdAt_idx" ON "Order"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_organizationId_status_confirmedAt_idx" ON "Payment"("organizationId", "status", "confirmedAt");

-- CreateIndex
CREATE INDEX "Payment_branchId_status_confirmedAt_idx" ON "Payment"("branchId", "status", "confirmedAt");
