-- Overrides de funciones por organización. Los defaults viven en el código.
ALTER TABLE "Organization"
  ADD COLUMN "featureOverrides" JSONB NOT NULL DEFAULT '{}';
