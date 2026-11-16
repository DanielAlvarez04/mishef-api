-- CreateEnum
CREATE TYPE "GuestSex" AS ENUM ('MASCULINO', 'FEMENINO', 'LGBT');

-- CreateEnum
CREATE TYPE "GuestAgeRange" AS ENUM ('NINO', 'JOVEN', 'ADULTO', 'ADULTO_MAYOR');

-- AlterTable
ALTER TABLE "OrderGuest" ADD COLUMN     "ageRange" "GuestAgeRange",
ADD COLUMN     "sex" "GuestSex";
