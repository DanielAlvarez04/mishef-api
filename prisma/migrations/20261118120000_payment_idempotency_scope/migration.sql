-- La clave de idempotencia de un pago se acota al negocio.
-- Antes era única global: una colisión entre dos organizaciones hacía fallar
-- el cobro de la segunda aunque fueran claves distintas en origen.

DROP INDEX IF EXISTS "Payment_idempotencyKey_key";

CREATE UNIQUE INDEX "Payment_organizationId_idempotencyKey_key"
  ON "Payment"("organizationId", "idempotencyKey");
