# Redeem

一个包含后端和 React + Vite 前端的兑换与邮件查看项目。

后端有两套实现，接口、数据库、前端完全互通，可按需二选一：

| | 运行时 | 启动内存 | 说明 |
|---|---|---|---|
| Node 版 | Node.js 20+ | 约 90–120 MB | 原有实现，功能基线 |
| **Go 版** | 单个静态二进制 | 约 25–40 MB | 重写实现，无 Node 运行时依赖 |

两套共用同一个 SQLite 文件与同一套环境变量，可以原地切换、随时回滚。

## 功能

- 兑换码发放邮箱数据
- 订单查询与 TXT 下载
- 邮箱收件箱/垃圾箱分页查看
- 管理后台库存、卡密、记录管理
- 已兑换卡密回退：销毁卡密并将关联账号恢复为可用库存
- 兑换后 24 小时关闭在线访问，但永久保留后台库存与兑换历史

## 环境要求

- Node.js 20+
- npm 10+

## 安装

在项目根目录执行：

```bash
npm install
npm --prefix ui install
```

## 开发启动

一键同时启动前后端：

```bash
npm run dev
```

默认开发地址：

- 前端: `http://127.0.0.1:5173`
- 后端 API: `http://127.0.0.1:5002`

其中前端开发服务器已经代理 `/api` 到后端。

如果只想单独启动：

```bash
npm run dev:server
npm run dev:ui
```

## 生产构建

构建前端：

```bash
npm run build
```

启动服务：

```bash
npm start
```

## 镜像发布

推送到 `main`、推送 `v*` / 语义化版本 tag，或手动触发 `Docker Image` 工作流时，
会在 GitHub Actions 中构建镜像并推送到 GitHub Container Registry：

- 镜像地址：`ghcr.io/chouhx/redeem`
- 标签规则：`main` 分支 → `main`、`latest`、`sha-xxxxxxx`；tag `1.2.3` → `1.2.3`、`1.2`、`latest`；PR → 只构建不推送
- 构建平台：默认 `linux/amd64` + `linux/arm64`（手动触发可只选单平台）
- PR 触发只做 Dockerfile 构建校验，不推送

拉取使用已发布镜像：

```bash
docker pull ghcr.io/chouhx/redeem:latest

docker run -d --name redeem -p 5002:5002 \
  -e ADMIN_TOKEN=your-token \
  -v "$PWD/data:/app/data" \
  ghcr.io/chouhx/redeem:latest
```

本地自行构建仍可用：

```bash
docker compose up -d --build
```

> 首次推送后，GHCR 上的包默认是私有的。如需匿名拉取，在 GitHub 的
> `Packages` → 该镜像 → `Package settings` 中把可见性改为 `Public`。

## 常用环境变量

后端默认会读取根目录 `.env`：

- `NODE_BACKEND_PORT`，默认 `5002`
- `NODE_BACKEND_HOST`，默认 `0.0.0.0`
- `ADMIN_TOKEN`，默认 `admin123`
- `ADMIN_PATH`，默认 `/admin`
- `DB_PATH`，默认 `./outlook_manager.db`
- `UPLOAD_DIR`，广告位图片上传根目录，默认 `./data/uploads`（对外访问路径 `/uploads/ads/<文件名>`）
- `REDEEM_ACCESS_TTL_MS`，兑换后账号数据保留时长，默认 `86400000`（24 小时）

## 测试

```bash
npm test
```

## Go 后端

代码在 `backend/`，纯 Go 实现（SQLite 走 `modernc.org/sqlite`，不需要 cgo）。

### 构建与启动

```bash
# 1. 先构建前端产物（Go 后端只负责托管静态文件）
npm run build

# 2. 编译后端
cd backend && go build -o redeem-server ./cmd/server && cd ..

# 3. 启动（环境变量与 Node 版完全一致）
DB_PATH=./outlook_manager.db ./backend/redeem-server
```

二进制约 17 MB，静态链接，可直接拷到没有运行时的新主机上跑。

### 容器

```bash
# 只起 Go 版
docker compose --profile go up -d --build

# 或直接用已发布镜像
docker run -d --name redeem -p 5002:5002 \
  -e ADMIN_TOKEN=your-token \
  -v "$PWD/data:/app/data" \
  ghcr.io/chouhx/redeem:latest-go
```

镜像标签带 `-go` 后缀（`latest-go`、`main-go`、`1.2.3-go` 等），Node 版仍是 `latest`。

### 与 Node 版的一致性

`scripts/parity-http.py` 会把同一份数据库复制两份，分别起 Node 与 Go 服务，
发同一串请求并逐字段比对响应（读接口要求完全一致，写接口把随机卡密、
时间戳等易变值归一化后比对）。

```bash
cp app.db node.db && cp app.db go.db
DB_PATH=./node.db NODE_BACKEND_PORT=5101 node src/server.js &
DB_PATH=./go.db   NODE_BACKEND_PORT=5102 ./backend/redeem-server &
ADMIN_TOKEN=<库里的 admin_token> python3 scripts/parity-http.py
```

当前覆盖 55 个用例（目录、概览、类型、库存、卡密、记录、兑换链路、
配置读写、错误路径、取件与上游代理的入参校验），差异为 0。

Go 侧单元测试：

```bash
cd backend && go test ./...
```

已知的一处有意差异：后台库存列表里的 `type_mail_protocols`，Node 版的列表
查询漏选了 `types.mail_protocols`，只能回落到单协议；Go 版补上了这一列。
该字段前端不消费，仅服务端序列化使用，比对脚本里已标注忽略。

### 迁移到 Go 版

1. 停掉 Node 容器（SQLite 单写者，不能两个进程同时开同一个库）。
2. 备份数据：`cp data/outlook_manager.db{,.bak}`。
3. 可选，回收历史空间：`sqlite3 data/outlook_manager.db 'VACUUM;'`
   （表结构迁移会留下空闲页，VACUUM 会重写文件；700 MB 级实测约 4 秒）。
4. 起 Go 版，首次启动会自动跑与 Node 版相同的迁移（加列、回填、建索引、FTS 重建）。

两套实现读写同一份 schema，回滚只需把容器换回 Node 版，不需要反向迁移。

## 查询性能

数据量到 10w 级别后，以下几处做过针对性优化（详见 `src/db.js`）：

- **取件协议物化列**：`redeem_inventory.pickup_imap` / `pickup_graph` 由 `pickup_protocols` 推导并建索引，
  取代原先每次查询都对全表做 `json_each` 的写法；配套触发器保证两者永不失配。
- **分页走覆盖索引**：`(筛选列…, id)` 复合索引 + 「先按索引取本页 id，再回表 join」的写法，
  消除 `ORDER BY id DESC LIMIT` 的临时排序，深翻页也从秒级降到几十毫秒。
- **批量操作分块**：批量改状态/删除改为分块 `IN (...)` 单语句，取代逐行 `SELECT` + `UPDATE`/`DELETE`。
- **兑换取号**：按协议索引直接取号，命中即返回，不再先做两次全表计数。

首次启动会自动迁移（加列 + 回填 + 建索引）。13w 行实测一次性迁移约 1.1s。

基准脚本（造 13w 行临时库，不碰正式数据）：

```bash
npm run bench:queries      # 各查询/批量操作耗时 + 标志列一致性核对
npm run bench:import       # 13w 行导入吞吐
npm run bench:migration    # 模拟旧库升级的启动迁移耗时
npm run verify:paging      # 分页结果与参考实现逐页比对
```
