-- Vincula las cuentas de mesa abiertas con su mesa física.
INSERT INTO "OrderTable" ("id", "orderId", "tableId", "isPrimary", "createdAt")
SELECT gen_random_uuid()::text, o."id", t."id", true, CURRENT_TIMESTAMP
FROM "Order" o
JOIN "DiningTable" t
  ON t."branchId" = o."branchId" AND t."number" = o."tableNumber"
WHERE o."status" = 'OPEN'
  AND o."channel" = 'DINE_IN'
  AND o."tableNumber" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "OrderTable" ot WHERE ot."orderId" = o."id" AND ot."tableId" = t."id"
  );
