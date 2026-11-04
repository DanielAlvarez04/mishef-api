-- Los artículos despublicados se archivan en vez de eliminarse o quedar solo
-- inactivos: así desaparecen del catálogo de artículos y conservan sus
-- presentaciones y opciones para volver a publicarlos.
ALTER TABLE "Product" ADD COLUMN "isArchived" BOOLEAN NOT NULL DEFAULT false;
