# syntax=docker/dockerfile:1

# =============================================================
# wadash-bot — WhatsApp bot + Telegram control plane
# Builds the @workspace/api-server bundle (esbuild) and runs it
# with the full pnpm node_modules for externalized native deps.
# =============================================================

# ---- Builder ----
FROM node:24-slim AS builder
WORKDIR /app

ENV CI=true
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable && corepack prepare pnpm@10 --activate

# Lock dependency layer first for caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY artifacts ./artifacts

RUN pnpm install --frozen-lockfile

# Bundle the api-server into dist/index.mjs
RUN pnpm --filter @workspace/api-server build

# ---- Runtime ----
FROM node:24-slim AS runtime
WORKDIR /app

# ffmpeg for audio/media commands (bin/ffmpeg is a symlink to /usr/bin/ffmpeg)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

# pnpm needed for runtime-only schema sync (drizzle push)
RUN corepack enable && corepack prepare pnpm@10 --activate

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/api-server/bin ./artifacts/api-server/bin
COPY --from=builder /app/artifacts/api-server/data ./artifacts/api-server/data
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/.npmrc ./.npmrc

EXPOSE 8080

CMD ["node", "artifacts/api-server/dist/index.mjs"]