-- Códigos de recuperación para la verificación en dos pasos por correo.

ALTER TABLE "User"
  ADD COLUMN "twoFactorRecoveryCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
