-- Dominio propio con verificación por DNS.
-- `domain` ya existía como texto libre; ahora exige token y fecha de
-- verificación para considerarse activo.

ALTER TABLE "Organization"
    ADD COLUMN "domainToken" TEXT,
    ADD COLUMN "domainVerifiedAt" TIMESTAMP(3);
