# Go 后端镜像：前端仍用 Node 构建静态产物，运行期只有单个静态二进制。
# 与 Node 版 Dockerfile 并存，靠镜像标签区分，方便灰度与回滚。

FROM node:20-bookworm-slim AS frontend
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.11.1 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY ui/package.json ui/package.json
RUN pnpm install --frozen-lockfile
COPY ui ./ui
RUN pnpm --filter ui run build

FROM golang:1.23-bookworm AS backend
WORKDIR /src
# 纯 Go 驱动，关掉 cgo 才能得到静态二进制。
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend ./
RUN go build -ldflags="-s -w" -o /out/redeem-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app

COPY --from=backend /out/redeem-server /app/redeem-server
COPY --from=frontend /app/ui/dist /app/ui/dist

ENV FRONTEND_DIST_DIR=/app/ui/dist \
    DB_PATH=/app/data/outlook_manager.db \
    UPLOAD_DIR=/app/data/uploads \
    NODE_BACKEND_PORT=5002 \
    NODE_BACKEND_HOST=0.0.0.0

EXPOSE 5002
USER nonroot:nonroot

ENTRYPOINT ["/app/redeem-server"]
