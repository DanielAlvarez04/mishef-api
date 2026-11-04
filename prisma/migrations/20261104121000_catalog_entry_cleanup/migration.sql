-- La imagen vive ahora en `CatalogEntry`; las columnas duplicadas de artículo
-- y receta ya no se usan.
ALTER TABLE "Product" DROP COLUMN "imageKey",
DROP COLUMN "imageName",
DROP COLUMN "imageUrl";

ALTER TABLE "Recipe" DROP COLUMN "imageKey",
DROP COLUMN "imageName",
DROP COLUMN "imageUrl";
