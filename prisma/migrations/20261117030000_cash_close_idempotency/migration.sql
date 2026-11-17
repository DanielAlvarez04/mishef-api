-- Idempotencia del cierre de caja para reintentos offline.

ALTER TABLE "CashSession"
    ADD COLUMN "closeIdempotencyKey" TEXT;

CREATE UNIQUE INDEX "CashSession_closeIdempotencyKey_key"
    ON "CashSession"("closeIdempotencyKey");
