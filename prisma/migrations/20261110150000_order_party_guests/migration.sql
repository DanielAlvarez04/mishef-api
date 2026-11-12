-- CreateEnum
CREATE TYPE "GuestTitle" AS ENUM ('NINO', 'NINA', 'JOVEN', 'SENORITA', 'SENOR', 'SENORA', 'SENOR_MAYOR', 'SENORA_MAYOR');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "partySize" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "OrderGuest" ADD COLUMN     "title" "GuestTitle",
ALTER COLUMN "name" SET DEFAULT '';
