-- Caja por sucursal, propinas, canales de pedido y consecutivo de tickets.

-- Enums
CREATE TYPE "OrderChannel" AS ENUM ('DINE_IN', 'COUNTER', 'PHONE', 'DELIVERY');
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "CashMovementType" AS ENUM ('WITHDRAWAL', 'DEPOSIT', 'EXPENSE', 'ADJUSTMENT');

-- Sucursal: propina sugerida
ALTER TABLE "Branch" ADD COLUMN "defaultTipPercent" INTEGER NOT NULL DEFAULT 0;

-- Pedido: canal, cliente y envío
ALTER TABLE "Order" ADD COLUMN "channel" "OrderChannel" NOT NULL DEFAULT 'DINE_IN';
ALTER TABLE "Order" ADD COLUMN "customerName" TEXT;
ALTER TABLE "Order" ADD COLUMN "customerPhone" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveryAddress" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveryFee" DECIMAL(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "scheduledAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "ticketNumber" INTEGER;

UPDATE "Order" SET "channel" = 'COUNTER' WHERE "isTakeaway" = true;

CREATE INDEX "Order_branchId_createdAt_idx" ON "Order"("branchId", "createdAt");

-- Pago: propina y turno de caja
ALTER TABLE "Payment" ADD COLUMN "tipAmount" DECIMAL(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "tipRecipientId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "cashReceived" DECIMAL(12, 2);
ALTER TABLE "Payment" ADD COLUMN "changeGiven" DECIMAL(12, 2);
ALTER TABLE "Payment" ADD COLUMN "sessionId" TEXT;

CREATE INDEX "Payment_sessionId_idx" ON "Payment"("sessionId");
CREATE INDEX "Payment_tipRecipientId_idx" ON "Payment"("tipRecipientId");

-- Turnos de caja
CREATE TABLE "CashSession" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
  "openedById" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openingFloat" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "closedById" TEXT,
  "closedAt" TIMESTAMP(3),
  "countedCash" DECIMAL(12, 2),
  "expectedCash" DECIMAL(12, 2),
  "difference" DECIMAL(12, 2),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CashSession_organizationId_branchId_status_idx" ON "CashSession"("organizationId", "branchId", "status");
CREATE INDEX "CashSession_openedAt_idx" ON "CashSession"("openedAt");

-- Un solo turno abierto por sucursal (y uno por organización sin sucursal).
CREATE UNIQUE INDEX "CashSession_branch_open_key"
  ON "CashSession"("branchId")
  WHERE "status" = 'OPEN' AND "branchId" IS NOT NULL;

CREATE UNIQUE INDEX "CashSession_org_open_no_branch_key"
  ON "CashSession"("organizationId")
  WHERE "status" = 'OPEN' AND "branchId" IS NULL;

CREATE TABLE "CashMovement" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT,
  "sessionId" TEXT NOT NULL,
  "type" "CashMovementType" NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  "reason" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CashMovement_sessionId_idx" ON "CashMovement"("sessionId");
CREATE INDEX "CashMovement_organizationId_createdAt_idx" ON "CashMovement"("organizationId", "createdAt");

-- Consecutivo diario de tickets por sucursal
CREATE TABLE "BranchDailySequence" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "lastNumber" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "BranchDailySequence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BranchDailySequence_branchId_date_key" ON "BranchDailySequence"("branchId", "date");

-- Foreign keys
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tipRecipientId_fkey"
  FOREIGN KEY ("tipRecipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_openedById_fkey"
  FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BranchDailySequence" ADD CONSTRAINT "BranchDailySequence_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
