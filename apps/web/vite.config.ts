import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // #69：css 不走 esbuild 压缩——其 css parser 对 custom property 值里的
  // 带引号字体名/转义序列解析断裂，曾把 :root 块截断导致 --topbar-h 等
  // 变量丢失（页面 8px 偏移 + 滚动崩坏的隐性根因之一）。22KB 的 CSS 不压缩可接受。
  build: { cssMinify: false },
  server: {
    port: 5173,
    proxy: {
      // 开发期把 /api 代理到 water-server，避免 CORS
      '/api': { target: 'http://127.0.0.1:3210', changeOrigin: true },
    },
  },
});
