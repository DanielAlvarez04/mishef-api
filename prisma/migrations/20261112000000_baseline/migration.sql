-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'WAITER', 'KITCHEN', 'CASHIER', 'INVENTORY_MANAGER');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderRoundStatus" AS ENUM ('PENDING', 'PREPARING', 'READY', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'TRANSFER', 'MERCADO_PAGO_POINT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('DINE_IN', 'COUNTER', 'PHONE', 'DELIVERY');

-- CreateEnum
CREATE TYPE "GuestTitle" AS ENUM ('NINO', 'NINA', 'JOVEN', 'SENORITA', 'SENOR', 'SENORA', 'SENOR_MAYOR', 'SENORA_MAYOR');

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('WITHDRAWAL', 'DEPOSIT', 'EXPENSE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('ADJUSTMENT', 'CONSUMPTION', 'RETURN', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "TwoFactorPurpose" AS ENUM ('LOGIN', 'ENABLE');

-- CreateEnum
CREATE TYPE "UnitCode" AS ENUM ('MG', 'G', 'KG', 'OZ', 'LB', 'ML', 'L', 'TSP', 'TBSP', 'CUP', 'FL_OZ', 'GAL', 'UNIT', 'HALF_PIECE', 'PAIR', 'HALF_DOZEN', 'DOZEN');

-- CreateEnum
CREATE TYPE "CategoryKind" AS ENUM ('ARTICLE', 'RECIPE');

-- CreateEnum
CREATE TYPE "OptionSelection" AS ENUM ('SINGLE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "OptionEffectAction" AS ENUM ('ADD', 'REPLACE', 'REMOVE');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT', 'FIXED', 'BOGO', 'PAY_X_GET_Y', 'SPECIAL_PRICE', 'FREE_ITEM', 'SECOND_HALF_PRICE');

-- CreateEnum
CREATE TYPE "ImageJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ImageJobTarget" AS ENUM ('CATALOG_ENTRY', 'VARIANT');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0.16,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "businessType" TEXT,
    "serviceTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "goals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hasBranches" BOOLEAN NOT NULL DEFAULT false,
    "useCoreSuggestions" BOOLEAN NOT NULL DEFAULT true,
    "useCoreOptionGroups" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "passwordHash" TEXT,
    "name" TEXT,
    "googleId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "onboardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "branchId" TEXT,
    "roles" "Role"[] DEFAULT ARRAY['WAITER']::"Role"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pinHash" TEXT,
    "pinUpdatedAt" TIMESTAMP(3),
    "pinAttempts" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultTipPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchStock" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "replacedBySessionId" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwoFactorCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "TwoFactorPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwoFactorCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "kind" "CategoryKind" NOT NULL DEFAULT 'ARTICLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "imageKey" TEXT,
    "imageUrl" TEXT,
    "imageVariants" JSONB,
    "imageName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "categoryId" TEXT,
    "catalogEntryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sku" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "taxRate" DECIMAL(5,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isCombo" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "priceAdjust" DECIMAL(12,2) NOT NULL DEFAULT 0.0000,
    "recipeFactor" DECIMAL(6,3) NOT NULL DEFAULT 1,
    "imageKey" TEXT,
    "imageUrl" TEXT,
    "imageVariants" JSONB,
    "imageName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductExtra" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductExtra_pkey" PRIMARY KEY ("id")
);

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
    "valueId" TEXT,
    "customName" TEXT,
    "priceDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "scaleFactor" DECIMAL(6,3) NOT NULL DEFAULT 1,
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
    "replacesIngredientId" TEXT,
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
    "payQuantity" INTEGER,
    "getQuantity" INTEGER,
    "specialPrice" DECIMAL(12,2),
    "freeItemId" TEXT,
    "freeVariantId" TEXT,
    "discountedItemId" TEXT,
    "discountedVariantId" TEXT,
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
CREATE TABLE "Menu" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startTime" TEXT,
    "endTime" TEXT,
    "groups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "group" TEXT,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "baseUnit" "UnitCode" NOT NULL DEFAULT 'UNIT',
    "displayUnit" "UnitCode" NOT NULL DEFAULT 'UNIT',
    "currentStock" DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
    "minStock" DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
    "maxStock" DECIMAL(12,4),
    "unitCost" DECIMAL(12,6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT,
    "locationId" TEXT,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientEquivalence" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "fromUnit" "UnitCode" NOT NULL,
    "toUnit" "UnitCode" NOT NULL,
    "factor" DECIMAL(12,6) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientEquivalence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIngredientExclusion" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductIngredientExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComboComponent" (
    "id" TEXT NOT NULL,
    "comboId" TEXT NOT NULL,
    "componentProductId" TEXT NOT NULL,
    "componentVariantId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComboComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductExtraIngredient" (
    "id" TEXT NOT NULL,
    "productExtraId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,

    CONSTRAINT "ProductExtraIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "notes" TEXT,
    "catalogEntryId" TEXT,
    "producesIngredientId" TEXT,
    "yieldQuantity" DECIMAL(12,4),
    "yieldUnit" "UnitCode",
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "variantId" TEXT,
    "label" TEXT,
    "quantity" DECIMAL(12,4) NOT NULL,
    "isOptional" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeIngredientOption" (
    "id" TEXT NOT NULL,
    "recipeIngredientId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeIngredientOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemIngredientChoice" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "recipeIngredientId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,

    CONSTRAINT "OrderItemIngredientChoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "ingredientId" TEXT,
    "ingredientName" TEXT NOT NULL,
    "displayUnit" "UnitCode" NOT NULL,
    "userId" TEXT,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "stockAfter" DECIMAL(12,4),
    "reason" TEXT,
    "referenceId" TEXT,
    "referenceType" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "branchId" TEXT,
    "tableNumber" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 1,
    "isTakeaway" BOOLEAN NOT NULL DEFAULT false,
    "channel" "OrderChannel" NOT NULL DEFAULT 'DINE_IN',
    "customerName" TEXT,
    "customerPhone" TEXT,
    "deliveryAddress" TEXT,
    "deliveryFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3),
    "ticketNumber" INTEGER,
    "status" "OrderStatus" NOT NULL DEFAULT 'OPEN',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0.0000,
    "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0.0000,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0.0000,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderGuest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "title" "GuestTitle",
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRound" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "OrderRoundStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "sentAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderRoundId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productVariantId" TEXT,
    "productName" TEXT NOT NULL,
    "variantName" TEXT,
    "productPrice" DECIMAL(12,2) NOT NULL,
    "taxRate" DECIMAL(5,4),
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "promotionId" TEXT,
    "promotionName" TEXT,
    "promotionType" "PromotionType",
    "guestId" TEXT,
    "guestName" TEXT,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemExtra" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "productExtraId" TEXT,
    "extraName" TEXT NOT NULL,
    "extraPrice" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "OrderItemExtra_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "OrderItemExclusion" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,

    CONSTRAINT "OrderItemExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" TEXT NOT NULL,
    "orderRoundId" TEXT NOT NULL,
    "previousStatus" TEXT,
    "newStatus" TEXT NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "branchId" TEXT,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "idempotencyKey" TEXT,
    "tipAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tipRecipientId" TEXT,
    "cashReceived" DECIMAL(12,2),
    "changeGiven" DECIMAL(12,2),
    "sessionId" TEXT,
    "provider" TEXT,
    "providerOrderId" TEXT,
    "providerPaymentId" TEXT,
    "providerStatus" TEXT,
    "providerStatusDetail" TEXT,
    "terminalId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "providerData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "countedCash" DECIMAL(12,2),
    "expectedCash" DECIMAL(12,2),
    "difference" DECIMAL(12,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "sessionId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchDailySequence" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BranchDailySequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "pairedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PosDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPairing" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "codeHash" TEXT NOT NULL,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosPairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosDisplay" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "state" JSONB,
    "stateUpdatedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PosDisplay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercadoPagoConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mpUserId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "refreshTokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRefreshedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercadoPagoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercadoPagoTerminal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "terminalId" TEXT NOT NULL,
    "name" TEXT,
    "operatingMode" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercadoPagoTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercadoPagoWebhookEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "topic" TEXT NOT NULL,
    "providerOrderId" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MercadoPagoWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValues" JSONB,
    "newValues" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "branchId" TEXT,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "subjectName" TEXT,
    "itemId" TEXT,
    "orderId" TEXT,
    "menuId" TEXT,
    "quantity" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "target" "ImageJobTarget" NOT NULL,
    "targetId" TEXT NOT NULL,
    "itemId" TEXT,
    "imageName" TEXT,
    "folder" TEXT NOT NULL,
    "tempKey" TEXT NOT NULL,
    "status" "ImageJobStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ImageJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_domain_key" ON "Organization"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

-- CreateIndex
CREATE INDEX "Membership_branchId_idx" ON "Membership"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "Branch_organizationId_isActive_idx" ON "Branch"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_organizationId_name_key" ON "Branch"("organizationId", "name");

-- CreateIndex
CREATE INDEX "BranchStock_ingredientId_idx" ON "BranchStock"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchStock_branchId_ingredientId_key" ON "BranchStock"("branchId", "ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_userId_key" ON "EmailVerificationToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "TwoFactorCode_userId_purpose_createdAt_idx" ON "TwoFactorCode"("userId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "TwoFactorCode_expiresAt_idx" ON "TwoFactorCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_userId_key" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "Category_organizationId_idx" ON "Category"("organizationId");

-- CreateIndex
CREATE INDEX "Category_kind_isCore_idx" ON "Category"("kind", "isCore");

-- CreateIndex
CREATE UNIQUE INDEX "Category_organizationId_kind_name_key" ON "Category"("organizationId", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_kind_code_key" ON "Category"("kind", "code");

-- CreateIndex
CREATE INDEX "CatalogEntry_organizationId_idx" ON "CatalogEntry"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_catalogEntryId_key" ON "Product"("catalogEntryId");

-- CreateIndex
CREATE INDEX "Product_organizationId_isActive_idx" ON "Product"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_sku_key" ON "Product"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE INDEX "ProductExtra_productId_idx" ON "ProductExtra"("productId");

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
CREATE INDEX "ItemOptionEffect_replacesIngredientId_idx" ON "ItemOptionEffect"("replacesIngredientId");

-- CreateIndex
CREATE INDEX "ItemOptionEffect_ingredientId_idx" ON "ItemOptionEffect"("ingredientId");

-- CreateIndex
CREATE INDEX "ComboPromotion_itemId_isActive_idx" ON "ComboPromotion"("itemId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ComboPromotion_itemId_key" ON "ComboPromotion"("itemId");

-- CreateIndex
CREATE INDEX "Menu_organizationId_isActive_idx" ON "Menu"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_organizationId_name_key" ON "Menu"("organizationId", "name");

-- CreateIndex
CREATE INDEX "MenuItem_menuId_idx" ON "MenuItem"("menuId");

-- CreateIndex
CREATE INDEX "MenuItem_itemId_idx" ON "MenuItem"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_menuId_itemId_key" ON "MenuItem"("menuId", "itemId");

-- CreateIndex
CREATE INDEX "Ingredient_organizationId_isActive_idx" ON "Ingredient"("organizationId", "isActive");

-- CreateIndex
CREATE INDEX "Ingredient_organizationId_categoryId_idx" ON "Ingredient"("organizationId", "categoryId");

-- CreateIndex
CREATE INDEX "Ingredient_organizationId_locationId_idx" ON "Ingredient"("organizationId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_organizationId_name_key" ON "Ingredient"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_organizationId_sku_key" ON "Ingredient"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "IngredientCategory_organizationId_isActive_idx" ON "IngredientCategory"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientCategory_organizationId_name_key" ON "IngredientCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "IngredientLocation_organizationId_isActive_idx" ON "IngredientLocation"("organizationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientLocation_organizationId_name_key" ON "IngredientLocation"("organizationId", "name");

-- CreateIndex
CREATE INDEX "IngredientEquivalence_ingredientId_idx" ON "IngredientEquivalence"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientEquivalence_ingredientId_fromUnit_toUnit_key" ON "IngredientEquivalence"("ingredientId", "fromUnit", "toUnit");

-- CreateIndex
CREATE INDEX "ProductIngredientExclusion_productId_idx" ON "ProductIngredientExclusion"("productId");

-- CreateIndex
CREATE INDEX "ProductIngredientExclusion_ingredientId_idx" ON "ProductIngredientExclusion"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductIngredientExclusion_productId_ingredientId_key" ON "ProductIngredientExclusion"("productId", "ingredientId");

-- CreateIndex
CREATE INDEX "ComboComponent_comboId_idx" ON "ComboComponent"("comboId");

-- CreateIndex
CREATE INDEX "ComboComponent_componentProductId_idx" ON "ComboComponent"("componentProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ComboComponent_comboId_componentProductId_componentVariantI_key" ON "ComboComponent"("comboId", "componentProductId", "componentVariantId");

-- CreateIndex
CREATE INDEX "ProductExtraIngredient_ingredientId_idx" ON "ProductExtraIngredient"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductExtraIngredient_productExtraId_ingredientId_key" ON "ProductExtraIngredient"("productExtraId", "ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_producesIngredientId_key" ON "Recipe"("producesIngredientId");

-- CreateIndex
CREATE INDEX "Recipe_organizationId_idx" ON "Recipe"("organizationId");

-- CreateIndex
CREATE INDEX "Recipe_variantId_idx" ON "Recipe"("variantId");

-- CreateIndex
CREATE INDEX "Recipe_categoryId_idx" ON "Recipe"("categoryId");

-- CreateIndex
CREATE INDEX "Recipe_catalogEntryId_idx" ON "Recipe"("catalogEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_productId_variantId_key" ON "Recipe"("productId", "variantId");

-- CreateIndex
CREATE INDEX "RecipeIngredient_recipeId_variantId_idx" ON "RecipeIngredient"("recipeId", "variantId");

-- CreateIndex
CREATE INDEX "RecipeIngredient_ingredientId_idx" ON "RecipeIngredient"("ingredientId");

-- CreateIndex
CREATE INDEX "RecipeIngredient_variantId_idx" ON "RecipeIngredient"("variantId");

-- CreateIndex
CREATE INDEX "RecipeIngredientOption_recipeIngredientId_idx" ON "RecipeIngredientOption"("recipeIngredientId");

-- CreateIndex
CREATE INDEX "RecipeIngredientOption_ingredientId_idx" ON "RecipeIngredientOption"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeIngredientOption_recipeIngredientId_ingredientId_key" ON "RecipeIngredientOption"("recipeIngredientId", "ingredientId");

-- CreateIndex
CREATE INDEX "OrderItemIngredientChoice_recipeIngredientId_idx" ON "OrderItemIngredientChoice"("recipeIngredientId");

-- CreateIndex
CREATE INDEX "OrderItemIngredientChoice_ingredientId_idx" ON "OrderItemIngredientChoice"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemIngredientChoice_orderItemId_recipeIngredientId_key" ON "OrderItemIngredientChoice"("orderItemId", "recipeIngredientId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_dedupeKey_key" ON "InventoryMovement"("dedupeKey");

-- CreateIndex
CREATE INDEX "InventoryMovement_organizationId_createdAt_idx" ON "InventoryMovement"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_branchId_createdAt_idx" ON "InventoryMovement"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_ingredientId_idx" ON "InventoryMovement"("ingredientId");

-- CreateIndex
CREATE INDEX "InventoryMovement_userId_idx" ON "InventoryMovement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_organizationId_status_createdAt_idx" ON "Order"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_branchId_status_createdAt_idx" ON "Order"("branchId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Order_branchId_createdAt_idx" ON "Order"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderGuest_orderId_idx" ON "OrderGuest"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRound_idempotencyKey_key" ON "OrderRound"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderRound_orderId_idx" ON "OrderRound"("orderId");

-- CreateIndex
CREATE INDEX "OrderRound_status_createdAt_idx" ON "OrderRound"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_orderRoundId_idx" ON "OrderItem"("orderRoundId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "OrderItem_guestId_idx" ON "OrderItem"("guestId");

-- CreateIndex
CREATE INDEX "OrderItemExtra_orderItemId_idx" ON "OrderItemExtra"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderItemOption_orderItemId_idx" ON "OrderItemOption"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderItemOption_itemOptionValueId_idx" ON "OrderItemOption"("itemOptionValueId");

-- CreateIndex
CREATE INDEX "OrderItemExclusion_ingredientId_idx" ON "OrderItemExclusion"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemExclusion_orderItemId_ingredientId_key" ON "OrderItemExclusion"("orderItemId", "ingredientId");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_orderRoundId_idx" ON "OrderStatusHistory"("orderRoundId");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_changedAt_idx" ON "OrderStatusHistory"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerOrderId_key" ON "Payment"("providerOrderId");

-- CreateIndex
CREATE INDEX "Payment_organizationId_status_createdAt_idx" ON "Payment"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_branchId_createdAt_idx" ON "Payment"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_provider_providerStatus_idx" ON "Payment"("provider", "providerStatus");

-- CreateIndex
CREATE INDEX "Payment_sessionId_idx" ON "Payment"("sessionId");

-- CreateIndex
CREATE INDEX "Payment_tipRecipientId_idx" ON "Payment"("tipRecipientId");

-- CreateIndex
CREATE INDEX "CashSession_organizationId_branchId_status_idx" ON "CashSession"("organizationId", "branchId", "status");

-- CreateIndex
CREATE INDEX "CashSession_openedAt_idx" ON "CashSession"("openedAt");

-- CreateIndex
CREATE INDEX "CashMovement_sessionId_idx" ON "CashMovement"("sessionId");

-- CreateIndex
CREATE INDEX "CashMovement_organizationId_createdAt_idx" ON "CashMovement"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BranchDailySequence_branchId_date_key" ON "BranchDailySequence"("branchId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "PosDevice_tokenHash_key" ON "PosDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "PosDevice_organizationId_branchId_idx" ON "PosDevice"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPairing_codeHash_key" ON "PosPairing"("codeHash");

-- CreateIndex
CREATE INDEX "PosPairing_expiresAt_idx" ON "PosPairing"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosDisplay_tokenHash_key" ON "PosDisplay"("tokenHash");

-- CreateIndex
CREATE INDEX "PosDisplay_organizationId_branchId_idx" ON "PosDisplay"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoConnection_organizationId_key" ON "MercadoPagoConnection"("organizationId");

-- CreateIndex
CREATE INDEX "MercadoPagoTerminal_organizationId_branchId_idx" ON "MercadoPagoTerminal"("organizationId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoTerminal_organizationId_terminalId_key" ON "MercadoPagoTerminal"("organizationId", "terminalId");

-- CreateIndex
CREATE UNIQUE INDEX "MercadoPagoWebhookEvent_requestId_key" ON "MercadoPagoWebhookEvent"("requestId");

-- CreateIndex
CREATE INDEX "MercadoPagoWebhookEvent_providerOrderId_idx" ON "MercadoPagoWebhookEvent"("providerOrderId");

-- CreateIndex
CREATE INDEX "MercadoPagoWebhookEvent_receivedAt_idx" ON "MercadoPagoWebhookEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_organizationId_name_occurredAt_idx" ON "AnalyticsEvent"("organizationId", "name", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_subjectType_subjectId_occurredAt_idx" ON "AnalyticsEvent"("subjectType", "subjectId", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_itemId_occurredAt_idx" ON "AnalyticsEvent"("itemId", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_menuId_occurredAt_idx" ON "AnalyticsEvent"("menuId", "occurredAt");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_orderId_idx" ON "AnalyticsEvent"("orderId");

-- CreateIndex
CREATE INDEX "AnalyticsEvent_occurredAt_idx" ON "AnalyticsEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "ImageJob_organizationId_status_idx" ON "ImageJob"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ImageJob_status_createdAt_idx" ON "ImageJob"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchStock" ADD CONSTRAINT "BranchStock_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchStock" ADD CONSTRAINT "BranchStock_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TwoFactorCode" ADD CONSTRAINT "TwoFactorCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogEntry" ADD CONSTRAINT "CatalogEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_catalogEntryId_fkey" FOREIGN KEY ("catalogEntryId") REFERENCES "CatalogEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductExtra" ADD CONSTRAINT "ProductExtra_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "ItemOptionEffect" ADD CONSTRAINT "ItemOptionEffect_replacesIngredientId_fkey" FOREIGN KEY ("replacesIngredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemOptionEffect" ADD CONSTRAINT "ItemOptionEffect_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboPromotion" ADD CONSTRAINT "ComboPromotion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboPromotion" ADD CONSTRAINT "ComboPromotion_freeItemId_fkey" FOREIGN KEY ("freeItemId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboPromotion" ADD CONSTRAINT "ComboPromotion_freeVariantId_fkey" FOREIGN KEY ("freeVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboPromotion" ADD CONSTRAINT "ComboPromotion_discountedItemId_fkey" FOREIGN KEY ("discountedItemId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboPromotion" ADD CONSTRAINT "ComboPromotion_discountedVariantId_fkey" FOREIGN KEY ("discountedVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Menu" ADD CONSTRAINT "Menu_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "IngredientCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "IngredientLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientCategory" ADD CONSTRAINT "IngredientCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientLocation" ADD CONSTRAINT "IngredientLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientEquivalence" ADD CONSTRAINT "IngredientEquivalence_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredientExclusion" ADD CONSTRAINT "ProductIngredientExclusion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredientExclusion" ADD CONSTRAINT "ProductIngredientExclusion_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_comboId_fkey" FOREIGN KEY ("comboId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_componentProductId_fkey" FOREIGN KEY ("componentProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComboComponent" ADD CONSTRAINT "ComboComponent_componentVariantId_fkey" FOREIGN KEY ("componentVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductExtraIngredient" ADD CONSTRAINT "ProductExtraIngredient_productExtraId_fkey" FOREIGN KEY ("productExtraId") REFERENCES "ProductExtra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductExtraIngredient" ADD CONSTRAINT "ProductExtraIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_catalogEntryId_fkey" FOREIGN KEY ("catalogEntryId") REFERENCES "CatalogEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_producesIngredientId_fkey" FOREIGN KEY ("producesIngredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredientOption" ADD CONSTRAINT "RecipeIngredientOption_recipeIngredientId_fkey" FOREIGN KEY ("recipeIngredientId") REFERENCES "RecipeIngredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredientOption" ADD CONSTRAINT "RecipeIngredientOption_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemIngredientChoice" ADD CONSTRAINT "OrderItemIngredientChoice_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemIngredientChoice" ADD CONSTRAINT "OrderItemIngredientChoice_recipeIngredientId_fkey" FOREIGN KEY ("recipeIngredientId") REFERENCES "RecipeIngredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemIngredientChoice" ADD CONSTRAINT "OrderItemIngredientChoice_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderGuest" ADD CONSTRAINT "OrderGuest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRound" ADD CONSTRAINT "OrderRound_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderRoundId_fkey" FOREIGN KEY ("orderRoundId") REFERENCES "OrderRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "OrderGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemExtra" ADD CONSTRAINT "OrderItemExtra_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemExtra" ADD CONSTRAINT "OrderItemExtra_productExtraId_fkey" FOREIGN KEY ("productExtraId") REFERENCES "ProductExtra"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemOption" ADD CONSTRAINT "OrderItemOption_itemOptionValueId_fkey" FOREIGN KEY ("itemOptionValueId") REFERENCES "ItemOptionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemExclusion" ADD CONSTRAINT "OrderItemExclusion_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemExclusion" ADD CONSTRAINT "OrderItemExclusion_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderRoundId_fkey" FOREIGN KEY ("orderRoundId") REFERENCES "OrderRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tipRecipientId_fkey" FOREIGN KEY ("tipRecipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchDailySequence" ADD CONSTRAINT "BranchDailySequence_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_pairedById_fkey" FOREIGN KEY ("pairedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPairing" ADD CONSTRAINT "PosPairing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPairing" ADD CONSTRAINT "PosPairing_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPairing" ADD CONSTRAINT "PosPairing_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDisplay" ADD CONSTRAINT "PosDisplay_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDisplay" ADD CONSTRAINT "PosDisplay_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDisplay" ADD CONSTRAINT "PosDisplay_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MercadoPagoConnection" ADD CONSTRAINT "MercadoPagoConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MercadoPagoTerminal" ADD CONSTRAINT "MercadoPagoTerminal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MercadoPagoTerminal" ADD CONSTRAINT "MercadoPagoTerminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageJob" ADD CONSTRAINT "ImageJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Índices parciales y expresivos que Prisma no puede representar en
-- schema.prisma y que antes vivían en migraciones sueltas. Se conservan aquí
-- para que una base nueva tenga exactamente las mismas garantías.
-- ============================================================================

-- Una receta base por artículo.
CREATE UNIQUE INDEX "Recipe_productId_base_key" ON "Recipe"("productId") WHERE "variantId" IS NULL;

-- Un insumo por receta y presentación.
CREATE UNIQUE INDEX "RecipeIngredient_common_ingredient_key" ON "RecipeIngredient"("recipeId", "ingredientId") WHERE "variantId" IS NULL;
CREATE UNIQUE INDEX "RecipeIngredient_variant_ingredient_key" ON "RecipeIngredient"("recipeId", "variantId", "ingredientId") WHERE "variantId" IS NOT NULL;

-- Un solo menú global por organización.
CREATE UNIQUE INDEX "Menu_organizationId_global_key" ON "Menu"("organizationId") WHERE "isGlobal" = true;

-- Una sola caja abierta por sucursal (y por organización si no hay sucursal).
CREATE UNIQUE INDEX "CashSession_branch_open_key" ON "CashSession"("branchId") WHERE "status" = 'OPEN' AND "branchId" IS NOT NULL;
CREATE UNIQUE INDEX "CashSession_org_open_no_branch_key" ON "CashSession"("organizationId") WHERE "status" = 'OPEN' AND "branchId" IS NULL;

-- Nombres únicos del core sin distinguir mayúsculas ni espacios.
CREATE UNIQUE INDEX "IngredientCategory_global_name_key" ON "IngredientCategory" (LOWER(BTRIM(name))) WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX "IngredientLocation_global_name_key" ON "IngredientLocation" (LOWER(BTRIM(name))) WHERE "organizationId" IS NULL;
