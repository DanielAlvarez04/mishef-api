-- Cambio de dirección del negocio (una vez) y alias de las anteriores.

ALTER TABLE "Organization"
    ADD COLUMN "slugChanges" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "SlugAlias" (
    "slug" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlugAlias_pkey" PRIMARY KEY ("slug")
);

CREATE INDEX "SlugAlias_organizationId_idx" ON "SlugAlias"("organizationId");

ALTER TABLE "SlugAlias" ADD CONSTRAINT "SlugAlias_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
