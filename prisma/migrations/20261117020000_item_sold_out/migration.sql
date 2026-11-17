-- Marca manual de artículo agotado para el menú público.

ALTER TABLE "Product"
    ADD COLUMN "isSoldOut" BOOLEAN NOT NULL DEFAULT false;
