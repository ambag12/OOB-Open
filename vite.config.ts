import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Both are reached only from inside the worker -- xlsx through a static
  // import, exceljs through a dynamic one. Neither is on a path the dev
  // server's dependency scanner crawls, so without this the first Excel
  // export hangs waiting for a bundle that is not being built.
  optimizeDeps: { include: ['xlsx', 'exceljs'] },
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
