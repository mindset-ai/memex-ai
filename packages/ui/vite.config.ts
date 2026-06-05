import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_API_PROXY overrides the backend target so E2E runs can point at a non-default port
// when another dev server is already holding 8080.
const API_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    port: 5173,
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
