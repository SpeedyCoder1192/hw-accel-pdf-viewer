import { defineConfig } from 'vite';

// The build output doubles as the unpacked extension: viewer.html is the
// extension page, and scripts/build-extension.mjs drops the MV3 glue beside it.
// Relative asset paths matter here -- the page is served from chrome-extension://.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: { viewer: 'viewer.html' },
      output: { manualChunks: { pdfjs: ['pdfjs-dist'] } },
    },
  },
  worker: { format: 'es' },
  server: { port: 5273, open: '/viewer.html' },
});
