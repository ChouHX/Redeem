FROM node:20-bookworm-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.11.1 --activate

# Stage 1: install the full workspace (used to build the UI)
FROM base AS workspace-deps

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY ui/package.json ui/package.json

RUN pnpm install --frozen-lockfile

# Stage 2: build the UI
FROM workspace-deps AS frontend-build

COPY ui ./ui
RUN pnpm --filter ui run build

# Stage 3: build a standalone backend node_modules using npm
# (workspace-aware pnpm deploy does not play well with the root package,
# so we install the backend deps from the root package.json directly.)
FROM base AS backend-prod

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Final runtime image
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV NODE_BACKEND_HOST=0.0.0.0
ENV NODE_BACKEND_PORT=5002
ENV DB_PATH=/app/data/outlook_manager.db

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend-prod /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=frontend-build /app/ui/dist ./ui/dist

RUN mkdir -p /app/data

EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:5002/ || exit 1

CMD ["node", "src/server.js"]
