import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // GitHub Pages project sites are served from https://user.github.io/<repo>/,
  // so every URL needs that prefix. Set BASE_PATH=/my-repo/ when building for
  // one. User/org sites (user.github.io) and Cloudflare Pages keep the default.
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5173 },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // The pinned Pyodide runtime in public/ is already ~15MB; the app bundle
    // itself is tiny, so a single chunk keeps startup simple.
    chunkSizeWarningLimit: 1024,
  },
  // Serve .py sources as raw strings so pyplay can be inlined into the bundle
  // rather than fetched at runtime.
  assetsInclude: ['**/*.whl'],
});
