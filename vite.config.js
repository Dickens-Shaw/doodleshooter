import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 8910, host: true, strictPort: true },
  preview: { port: 8910, host: true, strictPort: true },
  build: { outDir: 'dist', assetsDir: 'assets' },
});
