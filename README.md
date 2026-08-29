# EroEroEro ☕

极简漫画搜索网页。所有请求都经过本项目代理（**不直连、不 302**），前端只与本站后端交互。

当前唯一源：**nhentai**（已迁移到其 `/api/v2`）。

## 功能

- 关键词搜索（标题），并透传 nhentai 的搜索语法：`tag:"big breasts"`、`artist:name`、`-word`、`pages:>10` 等
- 按标签浏览 / 搜索（标签类型 Tab + 标签联想）
- 在线预览（阅读器，方向键翻页）
- 下载：后端**实时抓取每页图片并流式打包成 ZIP** 传回客户端（STORE 无重压缩，图片本身已压缩）
- 极简 UI，浅色 / 深色自适应

## 本地运行

```bash
npm install
npm run dev
# 打开 http://localhost:8787
```

生产构建（本地 / Docker 通用）：

```bash
npm run build
npm start
```

## Docker 部署

```bash
docker build -t eroeroero .
docker run --rm -p 8787:8787 eroeroero
```

## Cloudflare Workers 部署

```bash
npm install
npx wrangler login
npm run deploy:workers
```

`wrangler.toml` 已配置好入口（`src/index.ts`）。如需提高 nhentai 匿名限流，在 Worker 上绑定密钥并设置：

```bash
npx wrangler secret put NHENTAI_API_KEY
```

## Vercel 部署

直接把仓库导入 Vercel，或：

```bash
npm install -g vercel
vercel
```

入口为 `api/index.ts`（Hono Vercel adapter）。长下载流式传输可用 `vercel.json` 里的 `maxDuration` 调整（Hobby 计划上限 60s，Pro 可到 300s）。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 本地/容器监听端口 | `8787` |
| `NHENTAI_BASE` | nhentai API 基地址 | `https://nhentai.net` |
| `NHENTAI_API_KEY` | nhentai User API Key，提高限流（`Authorization: Key ...`），可选 | 无（匿名） |
| `NHENTAI_USER_AGENT` | 请求 UA，可选 | `EroEroEro/0.1 (https://github.com/...)` |

> 匿名限流参考（单个 IP）：搜索 10/min、详情 20/min、按标签 15/min。图片走 CDN（`i*` / `t*`）无该 API 限流，且失败会自动切换其它 CDN 节点。

## API（本项目自用，也可直接调用）

- `GET /api/search?q=...&sort=...&page=...&tag_id=...`
- `GET /api/gallery/:id`
- `GET /api/tags?q=...&limit=...`（标签联想）
- `GET /api/tags/browse?type=...&page=...`
- `GET /api/img?path=...&kind=image|thumb`（图片代理）
- `GET /api/download/:id`（流式 ZIP）
- `GET /api/health`

## 目录结构

```
src/         后端（Hono，跨 Node / Workers / Vercel）
  app.ts     路由与静态托管
  nhentai.ts nhentai /api/v2 客户端 + 内存缓存
  media.ts   CDN 图片代理（多节点故障切换）
  zip.ts     流式 ZIP writer
  assets.ts  前端内联产物（由 scripts/build-assets.mjs 生成）
public/      前端源码（HTML/CSS/JS）
scripts/     构建脚本
api/         Vercel 函数入口
```