FROM node:20-bookworm-slim AS base

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS backend-deps

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS frontend-build

WORKDIR /app/ui

COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui ./
RUN npm run build

FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV NODE_BACKEND_HOST=0.0.0.0
ENV NODE_BACKEND_PORT=5002
ENV DB_PATH=/app/data/outlook_manager.db

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY --from=frontend-build /app/ui/dist ./ui/dist

RUN mkdir -p /app/data

EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://127.0.0.1:5002/ || exit 1

CMD ["npm", "start"]
