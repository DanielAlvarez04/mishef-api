-- Promoción única por combo y parámetros específicos por tipo.
ALTER TABLE "ComboPromotion"
  ADD COLUMN "payQuantity" INTEGER,
  ADD COLUMN "getQuantity" INTEGER,
  ADD COLUMN "specialPrice" DECIMAL(12,2),
  ADD COLUMN "freeItemId" TEXT,
  ADD COLUMN "freeVariantId" TEXT,
  ADD COLUMN "discountedItemId" TEXT,
  ADD COLUMN "discountedVariantId" TEXT;

-- Conserva solo la promoción más reciente por combo antes de crear el índice único.
DELETE FROM "ComboPromotion" p
USING "ComboPromotion" q
WHERE p."itemId" = q."itemId"
  AND (
    p."createdAt" < q."createdAt"
    OR (p."createdAt" = q."createdAt" AND p."id" < q."id")
  );

UPDATE "ComboPromotion"
SET type = 'PAY_X_GET_Y',
    "payQuantity" = 1,
    "getQuantity" = 2
WHERE type = 'BOGO';

CREATE UNIQUE INDEX "ComboPromotion_itemId_key" ON "ComboPromotion"("itemId");

ALTER TABLE "ComboPromotion"
  ADD CONSTRAINT "ComboPromotion_freeItemId_fkey"
    FOREIGN KEY ("freeItemId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ComboPromotion_freeVariantId_fkey"
    FOREIGN KEY ("freeVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ComboPromotion_discountedItemId_fkey"
    FOREIGN KEY ("discountedItemId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ComboPromotion_discountedVariantId_fkey"
    FOREIGN KEY ("discountedVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Snapshot de la promoción aplicada en cada línea de pedido.
ALTER TABLE "OrderItem"
  ADD COLUMN "promotionId" TEXT,
  ADD COLUMN "promotionName" TEXT,
  ADD COLUMN "promotionType" "PromotionType";
