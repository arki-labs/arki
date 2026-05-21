ARG application_name=arki

# Bun binary source for package management in build stages
FROM oven/bun:latest AS bun-base

FROM node:22.14.0-alpine AS base

ARG SYSTEM_PACKAGES="libc6-compat python3 make g++ bash postgresql-dev git"

RUN apk add --no-cache ${SYSTEM_PACKAGES} && \
    apk update && \
    npm install -g turbo node-gyp

# Pruner stage
FROM base AS pruner
ARG application_name
WORKDIR /app

COPY package.json bun.lock turbo.json ./
COPY . .
RUN turbo prune --scope=@${application_name}/start --docker

# Dependencies installer
FROM base AS deps-installer
ARG application_name
WORKDIR /app

COPY --from=bun-base /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/bun.lock ./bun.lock

ENV CI=true
RUN bun install

# Builder stage
FROM deps-installer AS builder
ARG application_name

COPY --from=pruner /app/out/full/ .

ENV NODE_ENV=production \
    NITRO_PRESET=bun

ARG DB_URL
ARG AUTH_SECRET
ARG VITE_URL
ARG VITE_SENTRY_DSN
ARG VITE_AXIOM_TOKEN
ARG VITE_AXIOM_DATASET
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ARG NODE_ENV

ENV DB_URL=${DB_URL} \
    AUTH_SECRET=${AUTH_SECRET} \
    VITE_URL=${VITE_URL} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_AXIOM_TOKEN=${VITE_AXIOM_TOKEN} \
    VITE_AXIOM_DATASET=${VITE_AXIOM_DATASET} \
    SENTRY_ORG=${SENTRY_ORG} \
    SENTRY_PROJECT=${SENTRY_PROJECT} \
    SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN} \
    NODE_ENV=${NODE_ENV}

RUN rm -rf apps/${application_name}/start/.output

RUN --mount=type=cache,id=turbo-${application_name},target=/app/.turbo \
    turbo build --filter=@${application_name}/start

# Minimal runtime stage - Bun runtime
FROM oven/bun:1-alpine AS runner
ARG application_name

RUN apk add --no-cache curl libc6-compat && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

WORKDIR /app
USER appuser

COPY --from=builder --chown=appuser:nodejs /app/apps/${application_name}/start/.output ./apps/${application_name}/start/.output

# Vite SSR externalizes node_modules — copy for runtime resolution
COPY --from=builder --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/package.json ./package.json

# Copy workspace packages needed at runtime
COPY --from=builder --chown=appuser:nodejs /app/apps/${application_name}/backend ./apps/${application_name}/backend
COPY --from=builder --chown=appuser:nodejs /app/packages ./packages

EXPOSE 3000
ENV PORT=3000 \
    HOSTNAME="0.0.0.0" \
    NODE_ENV=production \
    APP_KEY=${application_name}

ARG DB_URL
ARG AUTH_SECRET
ARG VITE_URL
ARG VITE_SENTRY_DSN
ARG VITE_AXIOM_TOKEN
ARG VITE_AXIOM_DATASET

ENV DB_URL=${DB_URL} \
    AUTH_SECRET=${AUTH_SECRET} \
    VITE_URL=${VITE_URL} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_AXIOM_TOKEN=${VITE_AXIOM_TOKEN} \
    VITE_AXIOM_DATASET=${VITE_AXIOM_DATASET}

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["sh", "-c", "bun apps/${APP_KEY}/start/.output/server/index.mjs"]
