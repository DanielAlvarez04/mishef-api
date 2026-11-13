-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "useCoreCategories" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "useCoreIngredientCategories" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "useCoreRecipeCategories" BOOLEAN NOT NULL DEFAULT true;
