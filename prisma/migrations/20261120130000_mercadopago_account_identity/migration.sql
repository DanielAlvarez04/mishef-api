-- Identidad visible de la cuenta de Mercado Pago autorizada.
-- Permite distinguir entre varias cuentas al reconectar.

ALTER TABLE "MercadoPagoConnection"
  ADD COLUMN "mpEmail" TEXT,
  ADD COLUMN "mpNickname" TEXT;
