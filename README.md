# Ero³ ☕

极简聚合漫画搜索网页。所有请求都经过本项目代理（**不直连、不 302**），前端只与本站后端交互，后端按 **source（渠道）** 组织，便于后续扩展更多来源。

当前 source：`nh` = **nhentai**（已迁移到其 `/api/v2`）；`eh` = **e-hentai / exhentai**（有 exhentai igneous 时优先 EXH，否则回退 EH）。

## 功能

- 关键词搜索（标题），并透传 nhentai 的搜索语法：`tag:"big breasts"`、`artist:name`、`-word`、`pages:>10` 等
- 渠道标签建议：输入 `nh:<部分字符>`（如 `nh:only`）会模糊匹配该渠道的标签（`males only` / `females only` / `only yesterday`），最多 5 条
- 渠道命名标签：`nh:<tag>`（如 `nh:males only`）直接按名字搜索该标签；页脚进入"点击查看所有标签"，所有标签以 `<渠道>:<tag>` 展示
- 搜索预览：搜索框停下 2 秒未输入时，输入框下方展示前 5 条结果，点击直接进入画廊
- 在线预览（阅读器，方向键翻页；预加载后续页，个数可配置默认 5）
- 下载：后端**实时抓取每页图片并流式打包成 ZIP** 直推浏览器（无固定 Content-Length，浏览器下载管理器直接落盘；前端不缓冲、不打包）
- 主题：默认跟随系统，可手动切换浅色 / 深色
- 缓存策略：**只缓存图片**（浏览器 + CDN 节点，≤3MB 强缓存）；HTML / JS / CSS / JSON / ZIP 一律 no-store

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
docker build -t ero3 .
docker run --rm -p 8787:8787 ero3
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
| `NHENTAI_USER_AGENT` | 请求 UA，可选。可保持默认，也可配置为 `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36` | `EroEroEro/0.1 (https://github.com/Eternal-Future/EroEroEro)` |
| `EHENTAI_COOKIE` | e-hentai 基础 Cookie（如 `ipb_member_id=...;ipb_pass_hash=...`），可选；不配则作为游客访问 E-Hentai | 无 |
| `EHENTAI_IGNEOUS_PROXY` | 获取 exhentai `igneous` 时使用的代理 URL（Node 本地/Docker 有效，带 `user:pass@host:port` 的形式） | 无 |
| `EHENTAI_IGNEOUS` | 手动指定已获取的 `igneous`，优先级最高；Workers/Vercel 可把 D1/KV 里的值喂到这里 | 无 |
| `EHENTAI_STATE_FILE` | 本地持久化 igneous 的 JSON 文件路径 | `.data/eh-state.json` |

> 匿名限流参考（单个 IP）：搜索 10/min、详情 20/min、按标签 15/min。图片走 CDN（`i*` / `t*`）无该 API 限流，且失败会自动切换其它 CDN 节点。

## API（source 明确区分，便于扩展）

统一前缀 `/api/source/:source`，`source` 当前支持 `nh` 或 `nhentai`。

- `GET /api/source/:source/search?q=...&tag=...&tag_id=...&sort=...&page=...`
- `GET /api/source/:source/gallery/:id`
- `GET /api/source/:source/tags?q=...&limit=...&type=...`（标签自动建议，含子串回退匹配）
- `GET /api/source/:source/tags/browse?type=...&page=...&sort=...`
- `GET /api/source/:source/img?path=...&kind=image|thumb`（图片代理）
- `GET /api/source/:source/download/:id`（流式 ZIP，无固定长度）
- `GET /api/health`、`GET /api/sources`

## 目录结构

```
src/              后端（Hono，跨 Node / Workers / Vercel）
  app.ts          路由与静态托管（按 source 分发）
  sources.ts      渠道抽象层：SourceAdapter 接口 + 渠道注册表，未来加源只需实现适配器
  nhentai.ts      nh 渠道实现（nhentai /api/v2 客户端 + 内存缓存）
  media.ts        CDN 图片代理（多节点故障切换，渠道无关）
  zip.ts          流式 ZIP writer
  assets.ts       前端内联产物（由 scripts/build-assets.mjs 生成）
public/           前端源码（HTML/CSS/JS）
scripts/          构建脚本
api/              Vercel 函数入口
```