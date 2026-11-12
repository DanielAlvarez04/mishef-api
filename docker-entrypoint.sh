#!/bin/sh
set -eu

# `migrate deploy` es idempotente y toma un advisory lock de Postgres, así que
# es seguro aunque el contenedor se reinicie o se levanten varias réplicas.
echo "[entrypoint] Aplicando migraciones de Prisma..."
./node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Iniciando API en :${PORT:-3001}"
exec node dist/src/main
