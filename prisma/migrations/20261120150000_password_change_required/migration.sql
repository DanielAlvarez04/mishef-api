-- Cambio obligatorio de la contraseña inicial de cuentas creadas por un ADMIN.

ALTER TABLE "User"
  ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
