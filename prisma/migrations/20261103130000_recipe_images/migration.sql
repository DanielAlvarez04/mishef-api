-- Imagen propia de la receta (la misma que usa el artículo al publicarse).
ALTER TABLE "Recipe" ADD COLUMN     "imageKey" TEXT,
ADD COLUMN     "imageName" TEXT,
ADD COLUMN     "imageUrl" TEXT;
