-- Nombre histórico del usuario que tomó la orden, para el ticket.
ALTER TABLE "Order" ADD COLUMN     "servedByName" TEXT;
