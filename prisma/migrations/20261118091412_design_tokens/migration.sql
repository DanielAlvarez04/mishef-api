-- CreateTable
CREATE TABLE "DesignTokens" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tokens" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignTokens_pkey" PRIMARY KEY ("id")
);
