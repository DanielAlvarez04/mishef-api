-- Secciones de un menú (p. ej. «Bebidas frías»). El nombre del grupo se guarda
-- en el propio artículo; `groups` conserva el orden de las secciones.
ALTER TABLE "Menu"
  ADD COLUMN "groups" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "MenuItem"
  ADD COLUMN "group" TEXT;
