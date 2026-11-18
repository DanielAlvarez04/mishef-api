-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "soldItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_soldItemId_key" ON "Ingredient"("soldItemId");

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_soldItemId_fkey" FOREIGN KEY ("soldItemId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
