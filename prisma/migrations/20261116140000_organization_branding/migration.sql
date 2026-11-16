-- Marca blanca y ubicación geográfica del negocio.

ALTER TABLE "Organization"
    ADD COLUMN "brandColor" TEXT,
    ADD COLUMN "logoUrl" TEXT,
    ADD COLUMN "address" TEXT,
    ADD COLUMN "latitude" DECIMAL(10, 7),
    ADD COLUMN "longitude" DECIMAL(10, 7);
