import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// VITE_API_PROXY overrides the backend target so E2E runs can point at a non-default port
// when another dev server is already holding 8080.
const API_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

// VITE_PORT lets an E2E run bind the UI dev server to a non-default port when 5173
// is already held (e.g. a stale dev server from another worktree). Playwright's
// webServer block + baseURL are wired to the same value so the suite stays
// self-consistent. Defaults to 5173 for normal `pnpm dev`.
const UI_PORT = Number(process.env.VITE_PORT ?? 5173)

export default defineConfig({
  // tailwindcss() is the v4 engine (spec-290 dec-2), replacing the PostCSS +
  // autoprefixer chain.
  plugins: [tailwindcss(), react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // spec-351: split the previously-monolithic bundle. Route-level React.lazy
    // (in App.tsx) carves the per-page chunks; manualChunks below pulls the
    // heavy, rarely-changing vendor families out of the entry chunk so first
    // paint no longer pays for charts (nivo), the pixi-backed home canvas,
    // markdown rendering, or the LangGraph runtime. Boundaries are grounded in
    // the baseline build: the ~3.2 MB entry chunk was dominated by these deps.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          // React core stays its own long-cached chunk (changes rarely).
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-react';
          }
          // Charts / data-viz (Insights, Pulse, QaReports surfaces only).
          if (/[\\/]node_modules[\\/](@nivo|d3-[^\\/]+)[\\/]/.test(id)) {
            return 'vendor-charts';
          }
          // pixi.js — the WebGL renderer behind the Home Canvas. Large and
          // only needed on /home. Rolldown already split RenderTargetSystem /
          // Geometry; fold the rest of pixi into one named vendor chunk.
          if (/[\\/]node_modules[\\/](pixi\.js|@pixi)[\\/]/.test(id)) {
            return 'vendor-pixi';
          }
          // Markdown rendering stack (DocDocument / Spec pages).
          if (
            /[\\/]node_modules[\\/](react-markdown|remark-[^\\/]+|rehype-[^\\/]+|hast-[^\\/]+|mdast-[^\\/]+|micromark[^\\/]*|unified|unist-[^\\/]+|vfile[^\\/]*|property-information|space-separated-tokens|comma-separated-tokens|highlight\.js|lowlight|devlop|hastscript|web-namespaces|zwitch|bail|trough|decode-named-character-reference|character-entities[^\\/]*|trim-lines|html-url-attributes|markdown-table|ccount|longest-streak)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-markdown';
          }
          // Motion (spec-508 Part 3) — the shared-layout morph behind the
          // first-run Explore welcome. Lazy-loaded via ExploreCompanionMount, so
          // this chunk is fetched only for first-time featured-demo visitors.
          if (/[\\/]node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/.test(id)) {
            return 'vendor-motion';
          }
          // LangGraph / LangChain runtime (the in-UI agent graph, std-11).
          if (
            /[\\/]node_modules[\\/](@langchain|langsmith|@cfworker|js-tiktoken)[\\/]/.test(
              id,
            )
          ) {
            return 'vendor-langgraph';
          }
          // Everything else from node_modules → a shared vendor chunk, keeping
          // the entry chunk to app + route-shell code.
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: UI_PORT,
    strictPort: true,
    // Listen on all interfaces + accept any host. With path-based routing
    // (t-23 of doc-15) the tenant context comes from the URL path, so the dev
    // server only needs to resolve on localhost:5173 — no hostfile entries.
    // The `host: true` + `allowedHosts: true` flags are kept so any leftover
    // `acme.localhost:5173` URLs still resolve (they'll redirect to apex on
    // first navigation).
    host: true,
    allowedHosts: true,
    // Reliable change detection: the macOS fsevents watcher intermittently
    // missed edits to already-loaded modules (serving a stale transform until a
    // full restart). Polling guarantees HMR fires on every save.
    watch: { usePolling: true },
    proxy: {
      // SSE event streams. These MUST get the no-buffering + no-Nagle hints, or
      // http-proxy gathers the long-lived stream and the client never sees
      // events → it reconnect-storms → the HTTP/1.1 6-connections-per-host limit
      // is exhausted and every later request (incl. page nav + mutations) stalls
      // on "Provisional headers".
      //
      // After the path-based-routing migration (t-23) the doc-events stream
      // lives under the tenant-scoped path `/api/<ns>/<mx>/docs/events`, so a
      // plain `/api/docs/events` prefix no longer matches it. A `^`-prefixed key
      // is treated as a RegExp by Vite's proxy matcher, so this catches both the
      // tenant-scoped doc stream and `/api/me/events`.
      '^/api/(.*/)?(docs/events|me/events)': {
        target: API_TARGET,
        // changeOrigin: false preserves the original Host header. Even though
        // tenancy lives in the URL path now, the server still inspects the
        // Host (e.g. CORS / cookie domain). Keep the original.
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            proxyRes.headers['cache-control'] = 'no-cache';
            proxyRes.headers['x-accel-buffering'] = 'no';
            if (req.socket && 'setNoDelay' in req.socket) {
              (req.socket as { setNoDelay: (v: boolean) => void }).setNoDelay(true);
            }
          });
        },
      },
      // Match ALL llm endpoints (chat, chat/create, tools/execute, conversations, …)
      // so creation-phase streaming also gets the no-buffering hints. The previous
      // `/api/llm/chat` pattern was narrower than `/api/llm/chat/create`.
      '/api/llm': {
        target: API_TARGET,
        changeOrigin: false,
        // selfHandleResponse is left default (false) so http-proxy pipes bytes
        // straight through without any internal buffering.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req) => {
            // SSE hints — stop any intermediary from gathering-then-flushing.
            proxyRes.headers['cache-control'] = 'no-cache';
            proxyRes.headers['x-accel-buffering'] = 'no';
            // Disable Node's Nagle on the upstream socket so small SSE writes
            // from the server aren't batched by the TCP stack before the
            // proxy pipes them to the admin.
            if (req.socket && 'setNoDelay' in req.socket) {
              (req.socket as { setNoDelay: (v: boolean) => void }).setNoDelay(true);
            }
          });
        },
      },
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
})
