-- Invitaciones por correo para sumar personal a un negocio.
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roles" "Role"[] DEFAULT ARRAY[]::"Role"[],
    "branchId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_organizationId_email_idx" ON "Invitation"("organizationId", "email");
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
