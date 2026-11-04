-- Opciones propias del artículo: no modifican la biblioteca del negocio.
ALTER TABLE "ItemOptionValue" ADD COLUMN "customName" TEXT,
ALTER COLUMN "valueId" DROP NOT NULL;
