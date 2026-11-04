-- Identidad global del catálogo: una entrada por artículo/receta.
CREATE TABLE "CatalogEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "imageKey" TEXT,
    "imageUrl" TEXT,
    "imageName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogEntry_organizationId_idx" ON "CatalogEntry"("organizationId");

ALTER TABLE "Product" ADD COLUMN "catalogEntryId" TEXT;
ALTER TABLE "Recipe" ADD COLUMN "catalogEntryId" TEXT;

CREATE UNIQUE INDEX "Product_catalogEntryId_key" ON "Product"("catalogEntryId");
CREATE INDEX "Recipe_catalogEntryId_idx" ON "Recipe"("catalogEntryId");

ALTER TABLE "CatalogEntry"
  ADD CONSTRAINT "CatalogEntry_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_catalogEntryId_fkey"
  FOREIGN KEY ("catalogEntryId") REFERENCES "CatalogEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Recipe"
  ADD CONSTRAINT "Recipe_catalogEntryId_fkey"
  FOREIGN KEY ("catalogEntryId") REFERENCES "CatalogEntry"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: cada artículo estrena su entrada con su mismo id, para que la
-- carpeta existente `catalog/{itemId}/` siga siendo válida.
INSERT INTO "CatalogEntry"
  ("id", "organizationId", "imageKey", "imageUrl", "imageName", "createdAt", "updatedAt")
SELECT "id", "organizationId", "imageKey", "imageUrl", "imageName", NOW(), NOW()
FROM "Product";

UPDATE "Product" SET "catalogEntryId" = "id";

-- Recetas independientes: entrada propia con el id de la receta.
INSERT INTO "CatalogEntry"
  ("id", "organizationId", "imageKey", "imageUrl", "imageName", "createdAt", "updatedAt")
SELECT "id", "organizationId", "imageKey", "imageUrl", "imageName", NOW(), NOW()
FROM "Recipe"
WHERE "productId" IS NULL;

UPDATE "Recipe" SET "catalogEntryId" = "id" WHERE "productId" IS NULL;

-- Recetas publicadas: comparten la entrada del artículo.
UPDATE "Recipe" r
SET "catalogEntryId" = p."catalogEntryId"
FROM "Product" p
WHERE r."productId" = p."id";

-- Si el artículo no tenía imagen pero su receta sí, la entrada hereda la de la
-- receta. El script de R2 mueve después el objeto a `catalog/{entryId}/`.
UPDATE "CatalogEntry" e
SET "imageKey" = src."imageKey",
    "imageUrl" = src."imageUrl",
    "imageName" = src."imageName"
FROM (
  SELECT DISTINCT ON (p."catalogEntryId")
    p."catalogEntryId",
    r."imageKey",
    r."imageUrl",
    r."imageName"
  FROM "Recipe" r
  JOIN "Product" p ON p."id" = r."productId"
  WHERE r."imageKey" IS NOT NULL
  ORDER BY p."catalogEntryId", r."updatedAt" DESC
) src
WHERE e."id" = src."catalogEntryId"
  AND e."imageKey" IS NULL;
