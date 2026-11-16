-- Id del custom hostname en Cloudflare for SaaS (dominio propio).

ALTER TABLE "Organization"
    ADD COLUMN "domainProviderId" TEXT;
