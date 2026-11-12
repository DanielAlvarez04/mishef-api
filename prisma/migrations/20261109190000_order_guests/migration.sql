-- Personas/comensales dentro de una cuenta y asignación de líneas.

CREATE TABLE "OrderGuest" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrderGuest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderGuest_orderId_idx" ON "OrderGuest"("orderId");

ALTER TABLE "OrderGuest" ADD CONSTRAINT "OrderGuest_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD COLUMN "guestId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "guestName" TEXT;

CREATE INDEX "OrderItem_guestId_idx" ON "OrderItem"("guestId");

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_guestId_fkey"
  FOREIGN KEY ("guestId") REFERENCES "OrderGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
