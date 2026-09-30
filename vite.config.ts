import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // 库构建输出在 dist/，页面产物单独输出，避免互相覆盖。
    outDir: 'dist-web',
  },
});
