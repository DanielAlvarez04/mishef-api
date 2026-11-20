-- Sesiones efímeras de impersonación para el panel de plataforma.
-- No modifican ni revocan las sesiones reales del usuario objetivo.

ALTER TABLE "AuthSession"
  ADD COLUMN "impersonatedById" TEXT;

CREATE INDEX "AuthSession_impersonatedById_idx"
  ON "AuthSession"("impersonatedById");
