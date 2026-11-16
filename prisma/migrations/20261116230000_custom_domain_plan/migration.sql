-- El dominio propio es una función de plan: se habilita por negocio.

ALTER TABLE "Organization"
    ADD COLUMN "customDomainEnabled" BOOLEAN NOT NULL DEFAULT false;
