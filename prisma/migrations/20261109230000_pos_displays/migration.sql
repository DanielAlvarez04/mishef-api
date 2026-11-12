-- Pantalla de cliente (monitor/tablet frente al cliente).

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

CREATE UNIQUE INDEX "PosDisplay_tokenHash_key" ON "PosDisplay"("tokenHash");
CREATE INDEX "PosDisplay_organizationId_branchId_idx" ON "PosDisplay"("organizationId", "branchId");

ALTER TABLE "PosDisplay" ADD CONSTRAINT "PosDisplay_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PosDisplay" ADD CONSTRAINT "PosDisplay_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PosDisplay" ADD CONSTRAINT "PosDisplay_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
