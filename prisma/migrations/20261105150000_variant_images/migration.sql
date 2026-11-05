-- Imagen propia de cada presentación. Si es NULL se usa la imagen base del
-- artículo (CatalogEntry), que sigue siendo la única compartida con la receta.
ALTER TABLE "ProductVariant"
  ADD COLUMN "imageKey" TEXT,
  ADD COLUMN "imageUrl" TEXT,
  ADD COLUMN "imageName" TEXT;
