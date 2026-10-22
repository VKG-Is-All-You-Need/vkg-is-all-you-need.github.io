# VKG is all you need

虚拟知识图谱（VKG）与 OBDA 资源索引的站点源码。线上地址：<https://vkg-is-all-you-need.github.io/>

站点基于 [Astro](https://astro.build/) 构建为纯静态页面，可部署到 GitHub Pages 或 Cloudflare。资源数据以 YAML 维护，构建时按 schema 校验。地理信息示例（`/examples/geo/`）的三维场景使用 [three.js](https://threejs.org/)，仅在该页面按需加载。

## 本地开发

需要 Node.js 22.23.4 或更高版本（Astro 7 的最低要求；CI 与线上构建使用的版本见 `.node-version`）。

```bash
npm install
npm run dev                                  # http://localhost:4321
npm run dev -- --host 0.0.0.0 --port 18766   # 局域网访问
```

Astro 7 的开发服务器以后台进程运行，可用 `npx astro dev status`、`npx astro dev logs`、`npx astro dev stop` 查看状态、日志或停止。

| 命令              | 作用                             |
| ----------------- | -------------------------------- |
| `npm run dev`     | 启动开发服务器（热更新）         |
| `npm run build`   | 构建到 `dist/`                   |
| `npm run preview` | 预览构建产物                     |
| `npm run check`   | Astro 与 TypeScript 类型检查     |
| `npm run format`  | 使用 Prettier 格式化             |
| `npm run verify`  | 依次执行类型检查、格式检查与构建 |

## 目录结构

```text
.
├── .github/workflows/     CI 与 GitHub Pages 部署
├── public/                原样输出的静态文件（favicon、og.png、品牌素材、_headers）
├── src/
│   ├── components/        组件：home/ resources/ learn/ geo/ ui/ 及全站顶栏、页脚、搜索面板
│   ├── data/              站点配置、资源分类与资源数据（resources.yaml）
│   ├── layouts/           页面骨架
│   ├── lib/               数据查询与工具函数；geo/ 为地理信息示例的街区数据与查询
│   ├── pages/             路由：/、/resources/、/learn/、/examples/geo/、/about/、404、robots.txt
│   ├── scripts/           客户端交互（主题、动画、搜索、筛选等）；geo/ 为三维场景
│   ├── styles/            设计变量与全局样式
│   └── content.config.ts  资源数据的 schema
├── astro.config.mjs
└── wrangler.jsonc         Cloudflare Workers 部署配置
```

## 维护资源数据

资源条目位于 [`src/data/resources.yaml`](src/data/resources.yaml)，字段如下：

| 字段       | 必填 | 说明                                                                  |
| ---------- | ---- | --------------------------------------------------------------------- |
| `id`       | 是   | 唯一标识，用作页面锚点（`/resources/#id`）                            |
| `category` | 是   | `standards` `tools` `tutorials` `benchmarks` `papers` `adjacent` 之一 |
| `title`    | 是   | 名称                                                                  |
| `url`      | 是   | 主链接                                                                |
| `summary`  | 是   | 一至两句客观描述：是什么、包含什么、用于什么                          |
| `note`     | 否   | 使用限制或注意事项                                                    |
| `venue`    | 否   | 论文的发表场合                                                        |
| `links`    | 否   | 次要链接列表，每项包含 `label` 与 `url`                               |

分类名称与说明在 [`src/data/categories.ts`](src/data/categories.ts)，核对日期在 [`src/data/site.ts`](src/data/site.ts) 的 `verifiedAt`。条目内容应与 [vkg-resources](https://github.com/VKG-Is-All-You-Need/vkg-resources) 保持同步。

## 部署

### GitHub Pages

推送到 `main` 后由 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 自动构建并发布。首次启用时，在仓库 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。

### Cloudflare

两种方式任选其一，均在 Cloudflare 控制台连接本仓库即可在每次推送后自动部署：

- **Workers（静态资源）**：Workers & Pages → Create → Import a repository。构建命令 `npm run build`，部署命令 `npx wrangler deploy`（读取 [`wrangler.jsonc`](wrangler.jsonc)）。
- **Pages**：Workers & Pages → Create → Pages → Connect to Git。框架预设选择 Astro，构建命令 `npm run build`，输出目录 `dist`。

部署到 Cloudflare 的域名时，在构建环境变量中设置 `SITE_URL`（如 `https://vkg.example.org`），以生成正确的 canonical 链接、sitemap 与 robots.txt。若 GitHub Pages 为主站、Cloudflare 仅作镜像，可不设置，canonical 将指向 GitHub Pages。

`public/_headers` 为 Cloudflare 设置静态资源缓存与安全响应头，GitHub Pages 会忽略该文件。

## 来源与许可

内容、视觉素材与字体的来源见 [PROVENANCE.md](PROVENANCE.md)。外部论文、数据集与软件的版权归原作者所有，本站仅提供链接。
