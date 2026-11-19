-- Propina capturada por la terminal Point y referencia de cobros manuales.

ALTER TYPE "TipSource" ADD VALUE IF NOT EXISTS 'TERMINAL';

ALTER TABLE "Payment" ADD COLUMN "reference" TEXT;
