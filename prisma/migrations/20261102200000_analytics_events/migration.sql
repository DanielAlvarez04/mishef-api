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
