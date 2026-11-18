-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SubscriptionProvider" AS ENUM ('MERCADO_PAGO', 'MANUAL');

-- CreateEnum
CREATE TYPE "PlanChangeStatus" AS ENUM ('PENDING', 'PAID', 'CANCELED');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'MERCADO_PAGO_LINK';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingEmail" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "providerCheckoutUrl" TEXT,
ADD COLUMN     "providerPreferenceId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceMonthly" DECIMAL(10,2) NOT NULL,
    "priceYearly" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "perBranch" BOOLEAN NOT NULL DEFAULT false,
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "maxBranches" INTEGER,
    "maxUsersPerBranch" INTEGER,
    "maxImagesPerItem" INTEGER NOT NULL DEFAULT 1,
    "maxVideosPerItem" INTEGER NOT NULL DEFAULT 0,
    "maxStorageBytes" BIGINT,
    "maxInventoryItems" INTEGER,
    "customDomain" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "features" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "provider" "SubscriptionProvider" NOT NULL DEFAULT 'MERCADO_PAGO',
    "interval" "BillingInterval" NOT NULL DEFAULT 'MONTH',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "providerPreapprovalId" TEXT,
    "payerEmail" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "graceEndsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "creditBalanceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanChange" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "fromPlanId" TEXT NOT NULL,
    "toPlanId" TEXT NOT NULL,
    "interval" "BillingInterval" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "amountDueCents" INTEGER NOT NULL,
    "status" "PlanChangeStatus" NOT NULL DEFAULT 'PENDING',
    "previousPreapprovalId" TEXT,
    "providerPreapprovalId" TEXT,
    "effectiveAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'SUBSCRIPTION',
    "status" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MXN',
    "providerPaymentId" TEXT,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "topic" TEXT NOT NULL,
    "providerId" TEXT,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSubscription_organizationId_key" ON "OrganizationSubscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSubscription_providerPreapprovalId_key" ON "OrganizationSubscription"("providerPreapprovalId");

-- CreateIndex
CREATE INDEX "OrganizationSubscription_planId_status_idx" ON "OrganizationSubscription"("planId", "status");

-- CreateIndex
CREATE INDEX "OrganizationSubscription_status_currentPeriodEnd_idx" ON "OrganizationSubscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "PlanChange_subscriptionId_status_idx" ON "PlanChange"("subscriptionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_providerPaymentId_key" ON "SubscriptionPayment"("providerPaymentId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_organizationId_createdAt_idx" ON "SubscriptionPayment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_subscriptionId_createdAt_idx" ON "SubscriptionPayment"("subscriptionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_requestId_key" ON "BillingWebhookEvent"("requestId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_providerId_idx" ON "BillingWebhookEvent"("providerId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_receivedAt_idx" ON "BillingWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPreferenceId_key" ON "Payment"("providerPreferenceId");

-- AddForeignKey
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSubscription" ADD CONSTRAINT "OrganizationSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanChange" ADD CONSTRAINT "PlanChange_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanChange" ADD CONSTRAINT "PlanChange_fromPlanId_fkey" FOREIGN KEY ("fromPlanId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanChange" ADD CONSTRAINT "PlanChange_toPlanId_fkey" FOREIGN KEY ("toPlanId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Semilla de planes comerciales de Mishef.
INSERT INTO "Plan" (
  "id", "code", "name", "description", "priceMonthly", "priceYearly",
  "currency", "perBranch", "trialDays", "maxBranches", "maxUsersPerBranch",
  "maxImagesPerItem", "maxVideosPerItem", "maxStorageBytes", "maxInventoryItems",
  "customDomain", "isActive", "isPublic", "sortOrder", "features",
  "createdAt", "updatedAt"
) VALUES
  (
    'plan_esencial', 'esencial', 'Esencial',
    'Para un solo local que esta empezando.',
    499, 4990, 'MXN', false, 14, 1, 10,
    1, 0, 1073741824, 1000,
    false, true, true, 1,
    '{"support":"Soporte por correo","domain":"negocio.mishef.co"}'::jsonb,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'plan_expansion', 'expansion', 'Expansion',
    'Para negocios con varias sucursales y mas contenido.',
    799, 7990, 'MXN', true, 14, NULL, 25,
    5, 1, NULL, NULL,
    true, true, true, 2,
    '{"support":"Soporte prioritario","domain":"dominio personalizado"}'::jsonb,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'plan_legacy', 'legacy', 'Legacy',
    'Plan interno para negocios que ya estaban con Mishef.',
    0, 0, 'MXN', false, 0, NULL, NULL,
    99, 99, NULL, NULL,
    true, true, false, 99,
    '{"support":"Soporte heredado","domain":"dominio personalizado"}'::jsonb,
    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
ON CONFLICT ("code") DO NOTHING;

-- Los negocios existentes conservan acceso completo (legacy).
INSERT INTO "OrganizationSubscription" (
  "id", "organizationId", "planId", "status", "provider", "interval",
  "quantity", "unitAmount", "currency", "createdAt", "updatedAt"
)
SELECT
  'legacy_' || o."id",
  o."id",
  p."id",
  'ACTIVE',
  'MANUAL',
  'MONTH',
  1,
  0,
  'MXN',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Organization" o
JOIN "Plan" p ON p."code" = 'legacy'
WHERE NOT EXISTS (
  SELECT 1 FROM "OrganizationSubscription" s WHERE s."organizationId" = o."id"
);