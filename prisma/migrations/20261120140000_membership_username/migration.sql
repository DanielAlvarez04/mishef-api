-- Username local por organización y dueño del negocio.
--
-- 1. El login deja de depender de `User.username` global.
-- 2. Cada membresía guarda su username local (único por organización).
-- 3. Los usernames viejos con `@dominio` se migran a la parte local.
-- 4. Se marca como dueño al ADMIN más antiguo de cada organización.

DROP INDEX IF EXISTS "User_username_key";
CREATE INDEX "User_username_idx" ON "User"("username");

ALTER TABLE "Membership" ADD COLUMN "username" TEXT;
ALTER TABLE "Membership" ADD COLUMN "isOwner" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TwoFactorCode" ADD COLUMN "organizationId" TEXT;

-- Backfill desde el campo legado, quitando el dominio si lo hubiera.
UPDATE "Membership" m
SET "username" = NULLIF(split_part(u."username", '@', 1), '')
FROM "User" u
WHERE m."userId" = u."id" AND u."username" IS NOT NULL;

-- Resolver duplicados dentro de cada organización antes de crear el índice.
DO $$
DECLARE
  rec RECORD;
  base TEXT;
  candidate TEXT;
  n INT;
BEGIN
  FOR rec IN
    SELECT m."id", m."organizationId", m."username"
    FROM "Membership" m
    WHERE m."username" IS NOT NULL AND m."organizationId" IS NOT NULL
    ORDER BY m."organizationId", m."createdAt", m."id"
  LOOP
    base := rec."username";
    candidate := base;
    n := 1;

    WHILE EXISTS (
      SELECT 1
      FROM "Membership" x
      WHERE x."organizationId" = rec."organizationId"
        AND x."username" = candidate
        AND x."id" <> rec."id"
    ) LOOP
      n := n + 1;
      candidate := base || n::text;
    END LOOP;

    IF candidate <> rec."username" THEN
      UPDATE "Membership" SET "username" = candidate WHERE "id" = rec."id";
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Membership_organizationId_username_key"
  ON "Membership"("organizationId", "username");
CREATE INDEX "Membership_username_idx" ON "Membership"("username");

-- Dueño: el ADMIN más antiguo de cada negocio.
WITH first_admin AS (
  SELECT DISTINCT ON (m."organizationId") m."id"
  FROM "Membership" m
  WHERE m."organizationId" IS NOT NULL
    AND 'ADMIN' = ANY(m."roles")
  ORDER BY m."organizationId", m."createdAt" ASC, m."id" ASC
)
UPDATE "Membership" m
SET "isOwner" = true
FROM first_admin f
WHERE m."id" = f."id";

-- Espejo legado para reportes: el username local de la primera membresía.
UPDATE "User" u
SET "username" = m."username"
FROM "Membership" m
WHERE m."userId" = u."id"
  AND m."username" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Membership" prev
    WHERE prev."userId" = u."id"
      AND prev."username" IS NOT NULL
      AND (
        prev."createdAt" < m."createdAt"
        OR (prev."createdAt" = m."createdAt" AND prev."id" < m."id")
      )
  );
