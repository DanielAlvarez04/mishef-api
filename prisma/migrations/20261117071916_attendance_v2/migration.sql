-- CreateEnum
CREATE TYPE "ShiftBreakType" AS ENUM ('LUNCH', 'REST', 'OTHER');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('WEB', 'KIOSK', 'ADMIN', 'OFFLINE');

-- CreateEnum
CREATE TYPE "AttendanceEventType" AS ENUM ('CLOCK_IN', 'LUNCH_START', 'LUNCH_END', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT', 'ADJUSTMENT', 'REVIEW');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "geofenceRadiusMeters" INTEGER NOT NULL DEFAULT 150,
ADD COLUMN     "latitude" DECIMAL(10,7),
ADD COLUMN     "longitude" DECIMAL(10,7);

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "attendanceKioskEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "attendanceApplyTolerance" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "attendanceDefaultBreakMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "attendanceEarlyLeaveGraceMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "attendanceLateGraceMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "attendanceLunchGraceMinutes" INTEGER NOT NULL DEFAULT 5;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "effectiveEndedAt" TIMESTAMP(3),
ADD COLUMN     "effectiveStartedAt" TIMESTAMP(3),
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT,
ADD COLUMN     "scheduleEntryId" TEXT,
ADD COLUMN     "scheduledEndedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledStartedAt" TIMESTAMP(3),
ADD COLUMN     "source" "AttendanceSource" NOT NULL DEFAULT 'WEB',
ADD COLUMN     "withinGeofence" BOOLEAN;

-- CreateTable
CREATE TABLE "ShiftBreak" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "type" "ShiftBreakType" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "effectiveMinutes" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceAdjustment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "shiftId" TEXT,
    "userId" TEXT NOT NULL,
    "type" "AttendanceEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedById" TEXT,
    "source" "AttendanceSource" NOT NULL DEFAULT 'WEB',
    "withinGeofence" BOOLEAN,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "note" TEXT,
    "metadata" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT,
    "weekStart" DATE NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleEntry" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftBreak_shiftId_startedAt_idx" ON "ShiftBreak"("shiftId", "startedAt");

-- CreateIndex
CREATE INDEX "AttendanceAdjustment_shiftId_createdAt_idx" ON "AttendanceAdjustment"("shiftId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceAdjustment_organizationId_createdAt_idx" ON "AttendanceAdjustment"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEvent_idempotencyKey_key" ON "AttendanceEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AttendanceEvent_organizationId_occurredAt_idx" ON "AttendanceEvent"("organizationId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_shiftId_occurredAt_idx" ON "AttendanceEvent"("shiftId", "occurredAt");

-- CreateIndex
CREATE INDEX "AttendanceEvent_userId_occurredAt_idx" ON "AttendanceEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "Schedule_organizationId_weekStart_idx" ON "Schedule"("organizationId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "Schedule_organizationId_branchId_weekStart_key" ON "Schedule"("organizationId", "branchId", "weekStart");

-- CreateIndex
CREATE INDEX "ScheduleEntry_userId_date_idx" ON "ScheduleEntry"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleEntry_scheduleId_userId_date_key" ON "ScheduleEntry"("scheduleId", "userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftTemplate_organizationId_name_key" ON "ShiftTemplate"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Shift_scheduleEntryId_idx" ON "Shift"("scheduleEntryId");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_scheduleEntryId_fkey" FOREIGN KEY ("scheduleEntryId") REFERENCES "ScheduleEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftBreak" ADD CONSTRAINT "ShiftBreak_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAdjustment" ADD CONSTRAINT "AttendanceAdjustment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAdjustment" ADD CONSTRAINT "AttendanceAdjustment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAdjustment" ADD CONSTRAINT "AttendanceAdjustment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAdjustment" ADD CONSTRAINT "AttendanceAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceAdjustment" ADD CONSTRAINT "AttendanceAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleEntry" ADD CONSTRAINT "ScheduleEntry_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleEntry" ADD CONSTRAINT "ScheduleEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftTemplate" ADD CONSTRAINT "ShiftTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
