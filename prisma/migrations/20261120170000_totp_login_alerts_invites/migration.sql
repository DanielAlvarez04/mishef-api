-- TOTP, alertas de inicio de sesión e invitaciones con username.

ALTER TABLE "User"
  ADD COLUMN "twoFactorTotpSecret" TEXT,
  ADD COLUMN "twoFactorTotpEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "lastLoginIp" TEXT,
  ADD COLUMN "lastLoginUserAgent" TEXT;

ALTER TABLE "Invitation"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "username" TEXT;
