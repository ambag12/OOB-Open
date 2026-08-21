import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Both are reached only from inside the worker -- xlsx through a static
  // import, exceljs through a dynamic one. Neither is on a path the dev
  // server's dependency scanner crawls, so without this the first Excel
  // export hangs waiting for a bundle that is not being built.
  optimizeDeps: { include: ['xlsx', 'exceljs'] },
  server: {
    // The session cookie is set by FastAPI, so the dev server has to look like
    // the same origin to the browser -- otherwise the cookie is cross-site and
    // never sent back. Everything the API owns is proxied through.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
    // Deep links (/login, /verify?token=..., /admin) are client routes. Vite's
    // dev server already falls back to index.html for them; the production
    // server has to be told to, which is what the catch-all in pages.py does.
  },
  build: {
    // SheetJS and ExcelJS are both large; they are split out below and the
    // Excel writer is imported lazily, so the first paint stays small.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  worker: { format: 'es' },
});
