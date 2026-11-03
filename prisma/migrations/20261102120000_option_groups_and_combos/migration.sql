-- CreateEnum
CREATE TYPE "OptionSelection" AS ENUM ('SINGLE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "OptionEffectAction" AS ENUM ('ADD', 'REPLACE', 'REMOVE');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT', 'FIXED', 'BOGO');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OptionGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OptionValue" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kitchenLabel" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemOptionGroup" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "selection" "OptionSelection" NOT NULL DEFAULT 'SINGLE',
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemOptionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemOptionValue" (
    "id" TEXT NOT NULL,
    "itemOptionGroupId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemOptionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemOptionEffect" (
    "id" TEXT NOT NULL,
    "itemOptionValueId" TEXT NOT NULL,
    "action" "OptionEffectAction" NOT NULL,
    "recipeIngredientId" TEXT,
    "ingredientId" TEXT,
    "quantity" DECIMAL(12,4),

    CONSTRAINT "ItemOptionEffect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboPromotion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startTime" TEXT,
    "endTime" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComboPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemOption" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "itemOptionValueId" TEXT,
    "groupName" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "kitchenLabel" TEXT,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OrderItemOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OptionGroup_organizationId_isActive_idx" ON "OptionGroup"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "OptionGroup_organizationId_name_key" ON "OptionGroup"("organizationId", "name");

-- CreateIndex
CREATE INDEX "OptionValue_groupId_idx" ON "OptionValue"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionValue_groupId_name_key" ON "OptionValue"("groupId", "name");

-- CreateIndex
CREATE INDEX "ItemOptionGroup_itemId_idx" ON "ItemOptionGroup"("itemId");

-- CreateIndex
CREATE INDEX "ItemOptionGroup_groupId_idx" ON "ItemOptionGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemOptionGroup_itemId_groupId_key" ON "ItemOptionGroup"("itemId", "groupId");

-- CreateIndex
CREATE INDEX "ItemOptionValue_itemOptionGroupId_idx" ON "ItemOptionValue"("itemOptionGroupId");

-- CreateIndex
CREATE INDEX "ItemOptionValue_valueId_idx" ON "ItemOptionValue"("valueId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemOptionValue_itemOptionGroupId_valueId_key" ON "ItemOptionValue"("itemOptionGroupId", "valueId");

-- CreateIndex
CREATE INDEX "ItemOptionEffect_itemOptionValueId_idx" ON "ItemOptionEffect"("itemOptionValueId");

-- CreateIndex
CREATE INDEX "ItemOptionEffect_recipeIngredientId_idx" ON "ItemOptionEffect"("recipeIngredientId");

-- CreateIndex
CREATE INDEX "ItemOptionEffect_ingredientId_idx" ON "ItemOptionEffect"("ingredientId");

-- CreateIndex
CREATE INDEX "ComboPromotion_itemId_isActive_idx" ON "ComboPromotion"("itemId", "isActive");

-- CreateIndex
CREATE INDEX "OrderItemOption_orderItemId_idx" ON "OrderItemOption"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderItemOption_itemOptionValueId_idx" ON "OrderItemOption"("itemOptionValueId");

-- AddForeignKey
ALTER TABLE "OptionGroup" ADD CONSTRAINT "OptionGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionValue" ADD CONSTRAINT "OptionValue_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionGroup" ADD CONSTRAINT "ItemOptionGroup_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionGroup" ADD CONSTRAINT "ItemOptionGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "OptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionValue" ADD CONSTRAINT "ItemOptionValue_itemOptionGroupId_fkey" FOREIGN KEY ("itemOptionGroupId") REFERENCES "ItemOptionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionValue" ADD CONSTRAINT "ItemOptionValue_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "OptionValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionEffect" ADD CONSTRAINT "ItemOptionEffect_itemOptionValueId_fkey" FOREIGN KEY ("itemOptionValueId") REFERENCES "ItemOptionValue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionEffect" ADD CONSTRAINT "ItemOptionEffect_recipeIngredientId_fkey" FOREIGN KEY ("recipeIngredientId") REFERENCES "RecipeIngredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionEffect" ADD CONSTRAINT "ItemOptionEffect_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboPromotion" ADD CONSTRAINT "ComboPromotion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_itemOptionValueId_fkey" FOREIGN KEY ("itemOptionValueId") REFERENCES "ItemOptionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
