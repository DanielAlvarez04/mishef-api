# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Dependencias con devDependencies (build)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=development

# `openssl` lo necesitan los motores de Prisma; `ca-certificates` para HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# `prisma generate` no se conecta a la base, pero el datasource necesita una URL.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN ./node_modules/.bin/prisma generate && npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force

COPY prisma.config.ts ./
COPY prisma ./prisma
# Se genera en la imagen final para que el cliente coincida con el schema y no
# dependa de que `npm prune` haya conservado `node_modules/.prisma`.
RUN ./node_modules/.bin/prisma generate

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
