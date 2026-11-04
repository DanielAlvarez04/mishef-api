-- Alcance de los insumos por presentación y efectos de opciones.
DROP INDEX "RecipeIngredient_recipeId_idx";
DROP INDEX "RecipeIngredient_recipeId_ingredientId_key";

ALTER TABLE "ItemOptionEffect" ADD COLUMN "replacesIngredientId" TEXT;
ALTER TABLE "ItemOptionValue" ADD COLUMN "scaleFactor" DECIMAL(6,3) NOT NULL DEFAULT 1;
ALTER TABLE "RecipeIngredient" ADD COLUMN "variantId" TEXT;

CREATE INDEX "ItemOptionEffect_replacesIngredientId_idx" ON "ItemOptionEffect"("replacesIngredientId");
CREATE INDEX "RecipeIngredient_recipeId_variantId_idx" ON "RecipeIngredient"("recipeId", "variantId");
CREATE INDEX "RecipeIngredient_variantId_idx" ON "RecipeIngredient"("variantId");

-- Prisma no puede expresar índices únicos parciales: uno para los insumos
-- comunes (variantId NULL) y otro para los de una presentación concreta.
CREATE UNIQUE INDEX "RecipeIngredient_common_ingredient_key"
  ON "RecipeIngredient"("recipeId", "ingredientId")
  WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "RecipeIngredient_variant_ingredient_key"
  ON "RecipeIngredient"("recipeId", "variantId", "ingredientId")
  WHERE "variantId" IS NOT NULL;

ALTER TABLE "ItemOptionEffect"
  ADD CONSTRAINT "ItemOptionEffect_replacesIngredientId_fkey"
  FOREIGN KEY ("replacesIngredientId") REFERENCES "Ingredient"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecipeIngredient"
  ADD CONSTRAINT "RecipeIngredient_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
