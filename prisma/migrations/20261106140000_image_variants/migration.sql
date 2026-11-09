-- Variantes optimizadas de imagen (AVIF + JPEG por ancho).
-- La clave `imageKey` deja de apuntar a un archivo original y pasa a ser un
-- prefijo con las medidas de origen (`{hash}-{ancho}x{alto}`).
ALTER TABLE "CatalogEntry" ADD COLUMN "imageVariants" JSONB;
ALTER TABLE "ProductVariant" ADD COLUMN "imageVariants" JSONB;
