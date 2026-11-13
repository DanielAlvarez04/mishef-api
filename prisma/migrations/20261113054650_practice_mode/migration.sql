-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "practiceMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "practiceUntil" TIMESTAMP(3);
