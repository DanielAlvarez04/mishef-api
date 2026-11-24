-- Plantilla de ticket por sucursal y claves del logo para la impresora Point.

ALTER TABLE "Organization"
  ADD COLUMN "logoKey" TEXT,
  ADD COLUMN "logoReceiptKey" TEXT;

ALTER TABLE "Branch"
  ADD COLUMN "receiptTemplate" JSONB;
