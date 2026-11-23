-- Búsqueda difusa de productos de proveedor.
--
-- `normalizeName` ya quita acentos y espacios al guardar, pero `unaccent`
-- cubre descripciones que lleguen con acentos y `pg_trgm` permite encontrar
-- "SALSA VERDE 1L" contra "SALSA VERDE 1 L" sin depender de coincidencia exacta.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE INDEX IF NOT EXISTS "SupplierProduct_normalizedName_trgm_idx"
  ON "SupplierProduct"
  USING gin ("normalizedName" gin_trgm_ops);
