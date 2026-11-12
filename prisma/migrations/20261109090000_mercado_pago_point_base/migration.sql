-- Integración con Mercado Pago Point (Fase 1).
--
-- - Nuevo método de pago MERCADO_PAGO_POINT.
-- - Campos de proveedor en Payment (id de order de MP, estado, terminal, etc.).
-- - Conexión OAuth por organización con tokens cifrados.
-- - Terminales sincronizadas y eventos de webhook deduplicados.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'MERCADO_PAGO_POINT';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerData" JSONB,
ADD COLUMN     "providerOrderId" TEXT,
ADD COLUMN     "providerPaymentId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "providerStatusDetail" TEXT,
ADD COLUMN     "terminalId" TEXT;

-- CreateTable
CREATE TABLE "MercadoPagoConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mpUserId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercadoPagoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercadoPagoTerminal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "terminalId" TEXT NOT NULL,
    "name" TEXT,
    "operatingMode" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercadoPagoTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercadoPagoWebhookEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "topic" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MercadoPagoWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoConnection_organizationId_key" ON "MercadoPagoConnection"("organizationId");

-- CreateIndex
CREATE INDEX "MercadoPagoTerminal_organizationId_branchId_idx" ON "MercadoPagoTerminal"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoTerminal_organizationId_terminalId_key" ON "MercadoPagoTerminal"("organizationId", "terminalId");

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoWebhookEvent_requestId_key" ON "MercadoPagoWebhookEvent"("requestId");

-- CreateIndex
CREATE INDEX "MercadoPagoWebhookEvent_providerOrderId_idx" ON "MercadoPagoWebhookEvent"("providerOrderId");

-- CreateIndex
CREATE INDEX "MercadoPagoWebhookEvent_receivedAt_idx" ON "MercadoPagoWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerOrderId_key" ON "Payment"("providerOrderId");

-- CreateIndex
CREATE INDEX "Payment_provider_providerStatus_idx" ON "Payment"("provider", "providerStatus");

-- AddForeignKey
ALTER TABLE "MercadoPagoConnection" ADD CONSTRAINT "MercadoPagoConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MercadoPagoTerminal" ADD CONSTRAINT "MercadoPagoTerminal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MercadoPagoTerminal" ADD CONSTRAINT "MercadoPagoTerminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
