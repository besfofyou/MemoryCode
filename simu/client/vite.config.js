import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时把 /api 转发到 Express（simu 默认监听 3000）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
