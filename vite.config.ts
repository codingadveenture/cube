/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/cube/',
  plugins: [react()],
  // Firebase is loaded on demand in its own chunk of about 640 kB; the main chunk stays small.
  build: { chunkSizeWarningLimit: 700 },
  // onnxruntime-web finds its .wasm file through import.meta.url, which the dev server's
  // dependency pre-bundling would break; the scanner imports it lazily.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  // The recognition worker (src/scan/vision/vision.worker.ts) imports onnxruntime-web on demand,
  // which needs code splitting, so the worker is built as an ES module.
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
