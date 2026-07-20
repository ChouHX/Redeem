# Redeem

一个包含 Node.js 后端和 React + Vite 前端的兑换与邮件查看项目。

## 功能

- 兑换码发放邮箱数据
- 订单查询与 TXT 下载
- 邮箱收件箱/垃圾箱分页查看
- 管理后台库存、卡密、记录管理
- 已兑换卡密回退：销毁卡密并将关联账号恢复为可用库存
- Worker Thread 后台 Token 测活、结果统计/下载与异常账号清理
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

## 常用环境变量

后端默认会读取根目录 `.env`：

- `NODE_BACKEND_PORT`，默认 `5002`
- `NODE_BACKEND_HOST`，默认 `0.0.0.0`
- `ADMIN_TOKEN`，默认 `admin123`
- `ADMIN_PATH`，默认 `/admin`
- `DB_PATH`，默认 `./outlook_manager.db`
- `REDEEM_ACCESS_TTL_MS`，兑换后账号数据保留时长，默认 `86400000`（24 小时）
- `TOKEN_CHECK_CONCURRENCY`，后台测活线程内并发数，默认 `6`
- `TOKEN_CHECK_TIMEOUT_MS`，单个 Token 测活超时，默认 `15000`

## 测试

```bash
npm test
```
