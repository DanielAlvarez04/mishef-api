-- Caja vinculada por QR (dispositivo) y PIN por membresía.

ALTER TABLE "Membership"
  ADD COLUMN "pinHash" TEXT,
  ADD COLUMN "pinUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "pinAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

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

CREATE UNIQUE INDEX "PosDevice_tokenHash_key" ON "PosDevice"("tokenHash");
CREATE INDEX "PosDevice_organizationId_branchId_idx" ON "PosDevice"("organizationId", "branchId");

ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PosDevice" ADD CONSTRAINT "PosDevice_pairedById_fkey"
  FOREIGN KEY ("pairedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

CREATE UNIQUE INDEX "PosPairing_codeHash_key" ON "PosPairing"("codeHash");
CREATE INDEX "PosPairing_expiresAt_idx" ON "PosPairing"("expiresAt");

ALTER TABLE "PosPairing" ADD CONSTRAINT "PosPairing_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PosPairing" ADD CONSTRAINT "PosPairing_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PosPairing" ADD CONSTRAINT "PosPairing_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
