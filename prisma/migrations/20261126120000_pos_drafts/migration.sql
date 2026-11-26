-- CreateTable
CREATE TABLE "PosDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "orderId" TEXT,
    "channel" "OrderChannel" NOT NULL DEFAULT 'DINE_IN',
    "tableNumber" TEXT,
    "tableId" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerSex" "GuestSex",
    "customerAgeRange" "GuestAgeRange",
    "deliveryAddress" TEXT,
    "deliveryFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "cart" JSONB NOT NULL,
    "guests" JSONB NOT NULL,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosDraft_organizationId_branchId_expiresAt_idx" ON "PosDraft"("organizationId", "branchId", "expiresAt");

-- CreateIndex
CREATE INDEX "PosDraft_expiresAt_idx" ON "PosDraft"("expiresAt");
