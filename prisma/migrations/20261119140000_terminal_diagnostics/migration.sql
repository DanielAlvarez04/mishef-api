-- Diagnóstico de terminales Point: modelo, sucursal/caja de Mercado Pago y
-- marca del último intento de sincronización automática.

ALTER TABLE "MercadoPagoConnection"
  ADD COLUMN "terminalsSyncedAt" TIMESTAMP(3);

ALTER TABLE "MercadoPagoTerminal"
  ADD COLUMN "model" TEXT,
  ADD COLUMN "storeId" TEXT,
  ADD COLUMN "posId" TEXT,
  ADD COLUMN "externalPosId" TEXT;
