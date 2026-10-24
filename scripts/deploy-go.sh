#!/usr/bin/env bash
# 把 Go 版后端部署到远端主机，并导入清洗后的生产数据。
#
# 用法：
#   scripts/deploy-go.sh root@43.166.8.180            # 拉 GHCR 镜像部署
#   scripts/deploy-go.sh root@43.166.8.180 5002       # 指定对外端口
#   scripts/deploy-go.sh root@43.166.8.180 5002 --build   # 在服务器上从源码构建
#
# 前置条件：本机已有可登录目标主机的 SSH 私钥（ssh-copy-id 或 authorized_keys）。
set -euo pipefail

TARGET="${1:-}"
PORT="${2:-5002}"
MODE="${3:-}"

if [[ -z "$TARGET" ]]; then
  echo "用法: $0 <user@host> [port] [--build]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLEAN_DB="${CLEAN_DB:-/c/Users/Z/Desktop/Redeem-export-2026-10-24/export-snapshot.cleaned.db}"
APP_DIR="${APP_DIR:-/root/api/redeem-go}"
IMAGE="${IMAGE:-ghcr.io/chouhx/redeem:latest-go}"
REPO_URL="${REPO_URL:-https://github.com/ChouHX/Redeem.git}"
# distroless 镜像以 nonroot(65532) 运行，挂载目录必须归它所有。
APP_UID=65532

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }

step "1/7 检查 SSH 连通性"
if ! ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET" 'true' 2>/dev/null; then
  echo "无法免密登录 $TARGET。" >&2
  echo "请先把本机公钥装到目标主机：" >&2
  echo "  ssh-copy-id $TARGET" >&2
  echo "或把 ~/.ssh/redeem_deploy.pub 的内容追加到目标机 /root/.ssh/authorized_keys。" >&2
  exit 1
fi
ok "SSH 可用"

step "2/7 检查远端 Docker"
ssh "$TARGET" 'command -v docker >/dev/null 2>&1' || {
  warn "远端没有 Docker，开始安装"
  ssh "$TARGET" 'curl -fsSL https://get.docker.com | sh && systemctl enable --now docker'
}
ssh "$TARGET" 'docker compose version >/dev/null 2>&1' \
  && ok "docker compose 可用" \
  || { echo "远端缺少 docker compose 插件，请先安装 docker-compose-plugin" >&2; exit 1; }

step "3/7 准备目录 $APP_DIR"
ssh "$TARGET" "mkdir -p $APP_DIR/data/uploads && chown -R $APP_UID:$APP_UID $APP_DIR/data && chmod 755 $APP_DIR"
ok "目录就绪（属主 $APP_UID）"

step "4/7 导入清洗后的数据"
if [[ ! -f "$CLEAN_DB" ]]; then
  echo "找不到清洗后的数据库：$CLEAN_DB" >&2
  echo "可用 CLEAN_DB=/path/to/db 覆盖。" >&2
  exit 1
fi
DB_SIZE=$(du -h "$CLEAN_DB" | cut -f1)
warn "上传 $DB_SIZE，视带宽可能需要几分钟"
scp -C "$CLEAN_DB" "$TARGET:$APP_DIR/data/outlook_manager.db"
ssh "$TARGET" "rm -f $APP_DIR/data/outlook_manager.db-wal $APP_DIR/data/outlook_manager.db-shm && chown $APP_UID:$APP_UID $APP_DIR/data/outlook_manager.db && chmod 644 $APP_DIR/data/outlook_manager.db"
ok "数据已导入"

step "5/7 写入 docker-compose.yml"
ssh "$TARGET" "cat > $APP_DIR/docker-compose.yml" <<EOF
services:
  redeem:
    image: $IMAGE
    container_name: redeem-go
    restart: unless-stopped
    ports:
      - "$PORT:5002"
    environment:
      NODE_BACKEND_PORT: "5002"
      NODE_BACKEND_HOST: "0.0.0.0"
      DB_PATH: /app/data/outlook_manager.db
      UPLOAD_DIR: /app/data/uploads
      FRONTEND_DIST_DIR: /app/ui/dist
      LOG_LEVEL: info
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "/app/redeem-server", "-healthcheck"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
EOF
ok "compose 已写入（对外端口 $PORT）"

step "6/7 启动容器"
if [[ "$MODE" == "--build" ]]; then
  warn "在服务器上从源码构建（首次约 3-5 分钟）"
  ssh "$TARGET" "command -v git >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq git)"
  ssh "$TARGET" "rm -rf $APP_DIR/src && git clone --depth 1 $REPO_URL $APP_DIR/src && cd $APP_DIR/src && docker build -f Dockerfile.go -t $IMAGE ."
else
  ssh "$TARGET" "docker pull $IMAGE"
fi
ssh "$TARGET" "cd $APP_DIR && docker compose up -d"
ok "容器已启动"

step "7/7 健康检查与数据校验"
for i in $(seq 1 30); do
  if ssh "$TARGET" "curl -fsS http://127.0.0.1:$PORT/api/redeem/catalog >/dev/null 2>&1"; then
    ok "接口已就绪（${i}0% 内）"
    break
  fi
  [[ $i -eq 30 ]] && { echo "健康检查超时，请查看 docker logs redeem-go" >&2; exit 1; }
  sleep 2
done

ssh "$TARGET" "curl -fsS http://127.0.0.1:$PORT/api/redeem/catalog" | head -c 300
echo
ssh "$TARGET" "docker ps --filter name=redeem-go --format '{{.Status}}'"

printf '\n\033[1;32m部署完成\033[0m\n'
echo "  访问地址: http://${TARGET#*@}:$PORT"
echo "  日志:     ssh $TARGET 'docker logs -f redeem-go'"
echo "  目录:     $APP_DIR"
echo
echo "注意：admin_token 以数据库 system_config 表为准（当前数据里是 beacON028），"
echo "      会覆盖容器环境变量 ADMIN_TOKEN。"
