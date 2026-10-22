// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 部署到其他域名（如 Cloudflare）时，在构建环境中设置 SITE_URL。
const site = process.env.SITE_URL ?? 'https://vkg-is-all-you-need.github.io';

export default defineConfig({
  site,
  trailingSlash: 'ignore',
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  integrations: [sitemap()],
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  vite: {
    // three.js 场景单独拆包，仅在地理信息示例页按需加载，体积超过默认的 500 kB 提示阈值属预期。
    build: { chunkSizeWarningLimit: 700 },
  },
});
