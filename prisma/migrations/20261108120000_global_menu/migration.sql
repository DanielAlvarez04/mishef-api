-- Menú global de referencia: uno por organización, creado automáticamente.
ALTER TABLE "Menu" ADD COLUMN "isGlobal" BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: permite muchos menús normales, pero solo uno global por
-- organización (la unicidad de Postgres no compara los `false` del WHERE).
CREATE UNIQUE INDEX "Menu_organizationId_global_key"
  ON "Menu" ("organizationId")
  WHERE "isGlobal" = true;
