import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const backendPort = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 3000);
const target = `http://127.0.0.1:${backendPort}`;

// The proxy keeps the browser's Host and Origin untouched (no changeOrigin), so both match each other
// and pass the backend's Host and Origin guards without extra configuration.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
  server: {
    host: process.env.FRONTEND_HOST ?? 'localhost',
    port: Number(process.env.FRONTEND_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': { target, ws: true } },
  },
  preview: { proxy: { '/api': { target, ws: true } } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // a loaded machine (several test runs at once) needs more than the 5 s default for the first, cold test of a file
    testTimeout: 20_000,
  },
});
