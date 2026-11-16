-- Costo de compra por unidad canónica en cada movimiento de inventario.
-- Permite calcular el food cost real con la última compra.

ALTER TABLE "InventoryMovement"
    ADD COLUMN "unitCost" DECIMAL(12, 6);
