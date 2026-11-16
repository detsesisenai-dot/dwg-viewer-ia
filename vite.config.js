import { defineConfig } from 'vite';

export default defineConfig({
  // O pacote carrega um .wasm grande; não deixe o Vite pré-empacotá-lo em dev.
  optimizeDeps: {
    exclude: ['@mlightcad/libredwg-web']
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000
  }
});
