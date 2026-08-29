# Ero³ ☕

聚合漫画搜索网页。前端只与本站后端交互，**图片、画廊、下载全部经后端代理：不直连、不 302**。后端按 **source（渠道）** 组织，加新源只需实现 `SourceAdapter`。

内置渠道：

| 渠道 | 名字 | 说明 |
| --- | --- | --- |
| `nh` | nhentai | v2 API，匿名可用，可配 API Key |
| `eh` | e-hentai / exhentai | 自动优先 EXH；igneous 失效或拿不到时回退 EH |
| `jm` | 禁漫 / JMComic | 游客搜索+详情，响应 AES-ECB 本地解密 |

## 功能

- 首页为全渠道混合流，按各画廊发布时间从新到旧排序。
- 关键词搜索；也透传 nhentai 语法：`tag:"big breasts"`、`artist:name`、`-word`、`pages:>10` 等。
- 渠道标签：
  - 输入 `nh:only` / `eh:巨乳` 有标签自动建议（最多 5 条，EH 走 EhTagTranslation 中文本地化数据）。
  - 点击建议或标签页脚浮层可精确按标签搜索。
  - `nh:<tag>`、`eh:<tag>` 也可直接手输。
- 多关键词 / 跨渠道搜索：
  - 空格 = **AND**
  - `&` = **OR**
  - 带空格的词用引号
  - 支持标签 + 关键词混用
- 搜索预览：输入停下 2 秒，输入框下方展示前 5 条结果。
- 阅读器：方向键 / 点击翻页，顺序预加载后续页（默认 5，可用 `?preload=N` 或 localStorage `ero3.preload` 配置），顶部显示预加载进度。
- 下载：后端实时抓页、**流式打 ZIP**（无固定 Content-Length）直推浏览器；zip 内平铺 `meta.json` + `0001.webp ...`，无内层文件夹。
- 主题：默认跟随系统，可手动切换浅色 / 深色。
- 鉴权：配置 `ERO_PASSWORD` 后，前端弹模糊背景令牌弹窗，API 需 `Authorization: Bearer <token>`。
- 调试：`--debug` 或 `ERO3_DEBUG=1` 打印请求日志。

## 本地运行

```bash
cp .env.example .env   # 按需填写
npm install
npm run dev            # http://localhost:8787
```

生产构建：

```bash
npm run build
npm start
# 调试
node dist/server.mjs --debug
```

## Docker

```bash
docker build -t ero3 .
docker run --rm -p 8787:8787 --env-file .env ero3
```

或部署到任意支持 Docker 的平台。

## Cloudflare Workers

```bash
npm install
npx wrangler login
npx wrangler d1 create ero3   # 首次；D1 用来存 EH igneous + 标签库
# 把返回的 database_id 填进 wrangler.toml 的 [[d1_databases]]
npm run deploy:workers
```

环境变量通过 `wrangler secret put` 或 Dashboard 设置；`ERO_PASSWORD`、`NHENTAI_API_KEY`、`EHENTAI_COOKIE`、`EHENTAI_IGNEOUS` 等都可放入 Worker secrets，D1 binding 名为 `EH_D1`。

## Vercel

```bash
npm install -g vercel
vercel
```

入口 `api/index.ts`。长下载的 `maxDuration` 按你的套餐在 `vercel.json` 调整（Hobby 60s / Pro 300s）。EH igneous 建议通过 `EHENTAI_IGNEOUS` 环境变量提供。

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 本地/容器端口 | `8787` |
| `ERO_PASSWORD` | 鉴权令牌；不设置则无鉴权 | 无 |
| `ERO3_DEBUG` | `1` 时打印调试日志（等同于启动参数 `--debug`） | 关闭 |
| `NHENTAI_BASE` | nhentai API 基地址 | `https://nhentai.net` |
| `NHENTAI_API_KEY` | nhentai API Key，提高限流 | 无 |
| `NHENTAI_USER_AGENT` | nhentai 请求 UA | `EroEroEro/0.1 ...` |
| `EHENTAI_COOKIE` | e-hentai 基础 Cookie（`ipb_member_id=...; ipb_pass_hash=...`） | 无 |
| `EHENTAI_IGNEOUS_PROXY` | 获取 exhentai `igneous` 时使用的代理（Node/Docker） | 无 |
| `EHENTAI_IGNEOUS` | 手动指定已获取的 igneous；Workers/Vercel 可喂入 D1/KV 持久化的值 | 无 |
| `EHENTAI_STATE_DIR` | 本地持久化目录 | `.data` |
| `EHENTAI_SQLITE_FILE` | 本地 SQLite 文件名 | `eh.sqlite` |

`.env` 会自动加载。模板见 `.env.example`。

### EH / EXH 的 igneous 逻辑

1. 启动时先读本地 SQLite / D1 / `EHENTAI_IGNEOUS`。
2. 没有 igneous 时，用 `EHENTAI_COOKIE` + `EHENTAI_IGNEOUS_PROXY` 请求 exhentai 首页，从 `Set-Cookie: igneous=...` 拿值并持久化。
3. 拿到有效 igneous 后在任意地区 IP 均可访问 EXH；拿不到就标记 blocked，不再重试，全量回退 EH。
4. 已缓存 igneous 失效时，自动重取一次并刷新缓存；若仍失败则回退 EH。

## 缓存策略

- 只缓存图片。
- 后端内存缓存：64MB 总量、单张 ≤3MB、TTL 24h。
- 浏览器：Service Worker LRU 总容量 **5MB**、单张 ≤3MB。
- CDN：图片带 `s-maxage=86400` 及 `CDN-Cache-Control` / `Vercel-CDN-Cache-Control`。
- 非图片（HTML / JS / CSS / JSON / ZIP）统一 `no-store`。

## API

统一前缀 `/api/source/:source`，`source` 支持 `nh`、`eh`、`all`（以及 `nhentai` / `ehentai` / `exhentai` 别名）。

```text
GET  /api/source/:source/search?q=&tag=&tag_id=&sort=&page=
GET  /api/source/:source/gallery/:id
GET  /api/source/:source/tags?q=&limit=&type=
GET  /api/source/:source/tags/browse?type=&page=&sort=
GET  /api/source/:source/img?path=&kind=image|thumb
GET  /api/source/:source/download/:id
GET  /api/auth/status
GET  /api/sources
GET  /api/health
```

## 目录结构

```text
src/
  app.ts            路由、鉴权、缓存、下载编排
  sources.ts        SourceAdapter 抽象 + 渠道注册表
  nhentai.ts        nhentai v2 客户端
  ehentai.ts        EH/EXH HTML 解析、igneous 获取、图片解析
  ehentai-node.ts   Node 专用：SQLite、igneous 代理
  ehtags.ts         EhTagTranslation 标签库（6h 自动合并更新，中文）
  ehstore.ts        KV 存储（Node=SQLite, Workers=D1）
  query.ts          AND/OR/跨渠道查询引擎
  nhDates.ts        NH 发布时间补全（DB 缓存 + 详情回源）
  media.ts          通用 CDN 图片抓取（多节点故障切换）
  imageCache.ts     服务端图片内存缓存
  zip.ts            流式 ZIP writer
  debug.ts          调试日志
public/             前端
scripts/            构建脚本
api/                Vercel 入口
```

## 备注

- nhentai 匿名限流：搜索 10/min、详情 20/min、按 tag 15/min；配 API Key 可缓解。
- EH 结果页缩略图会直接使用大图 URL（源站列表没有单独 thumb）。
- EH 下载偶尔有源站图片节点超时：单页会重试 3 次并尝试 EH 镜像；仍失败的页面会写占位说明，不破坏 ZIP 完整性。
- 有明确要改的问题时，用 `--debug` 启动并把日志和请求 URL 一起反馈。