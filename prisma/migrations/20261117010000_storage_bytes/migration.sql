-- Almacenamiento ocupado por organización (contador).

ALTER TABLE "Organization"
    ADD COLUMN "storageBytes" BIGINT NOT NULL DEFAULT 0;
