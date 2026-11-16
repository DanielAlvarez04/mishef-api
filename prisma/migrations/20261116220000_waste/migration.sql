-- Merma de insumos con costo y evidencia fotográfica.

CREATE TYPE "WasteReason" AS ENUM ('EXPIRED', 'DAMAGED', 'SPILL', 'OVERPRODUCTION', 'OTHER');

CREATE TABLE "Waste" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "ingredientId" TEXT,
    "ingredientName" TEXT NOT NULL,
    "quantity" DECIMAL(12, 4) NOT NULL,
    "displayUnit" "UnitCode" NOT NULL,
    "reason" "WasteReason" NOT NULL,
    "note" TEXT,
    "cost" DECIMAL(12, 2) NOT NULL,
    "photoKey" TEXT,
    "photoUrl" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Waste_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Waste_organizationId_createdAt_idx" ON "Waste"("organizationId", "createdAt");
CREATE INDEX "Waste_branchId_createdAt_idx" ON "Waste"("branchId", "createdAt");
CREATE INDEX "Waste_ingredientId_idx" ON "Waste"("ingredientId");

ALTER TABLE "Waste" ADD CONSTRAINT "Waste_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Waste" ADD CONSTRAINT "Waste_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Waste" ADD CONSTRAINT "Waste_ingredientId_fkey"
    FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Waste" ADD CONSTRAINT "Waste_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
