// spec-222 t-5 (dec-1 / ac-7 / ac-8) — the embeddable SDK bundle build.
//
// Produces the self-contained drop-in a plain static HTML page includes with ONE
// <script> + ONE init() call (no build step on the site). The output is:
//   - a THIN loader entry (loader-*.js)  — registers window.mindset.guide, renders
//     the at-rest Specky doorway, NO React/engine;
//   - a SEPARATE, hashed engine chunk (engine-*.js) — the heavy React session,
//     fetched ONLY on the first doorway click via the loader's dynamic import (ac-8).
//
// WHY ES FORMAT (not IIFE/UMD): Rollup's IIFE/UMD outputs CANNOT code-split — they
// force `inlineDynamicImports`, which would fold the entire engine back into the
// single loader file and defeat the lazy-load contract (ac-8). The ES output keeps
// the native dynamic `import('./engine')` as a real, separately-fetched chunk. The
// site therefore includes it as `<script type="module" src="/js/memex-guide.js">`;
// the global registration (window.mindset.guide) works identically from a module.
//
// This build is SEPARATE from `build` (tsc), which still typechecks src/ (the app
// consumes guide-sdk SOURCE via a Vite alias, so tsc must stay green).

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Inline the small Specky SVGs as data URIs (they're <4KB) so the bundle has no
  // sidecar asset to host/route — the doorway needs zero extra requests.
  build: {
    outDir: resolve(here, 'dist-bundle'),
    emptyOutDir: true,
    // Default 4KB inline limit already inlines the Specky SVGs; keep it explicit.
    assetsInlineLimit: 4096,
    // CSS the engine pulls in is injected into the document by Vite's runtime; for
    // shadow-DOM isolation the doorway's CSS is authored inline in the loader and
    // lives in the shadow root. (Engine Tailwind utility classes are the host
    // app's concern; the website ships its own theme — see the t-5 report.)
    cssCodeSplit: true,
    rollupOptions: {
      input: resolve(here, 'src/bundle/loader.ts'),
      // ES output is what enables code-splitting (see header). The loader is the
      // entry; the dynamic import('./engine') becomes its own chunk.
      output: {
        format: 'es',
        dir: resolve(here, 'dist-bundle'),
        entryFileNames: 'memex-guide.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
        // Name the lazily-imported engine chunk so the split is legible in the
        // output (and assertable in the build test).
        manualChunks: undefined,
      },
    },
    // Keep the engine chunk readable enough for the split assertion; minify still
    // proves a realistic size delta between loader and engine.
    minify: 'esbuild',
    target: 'es2020',
  },
});
