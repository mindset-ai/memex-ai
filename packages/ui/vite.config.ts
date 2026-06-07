import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { existsSync, createReadStream } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// spec-190 (dec-8) — serve the Silero VAD / onnxruntime-web assets from public/vad
// as RAW files in DEV. onnxruntime-web 1.26 loads its wasm glue by dynamically
// importing `/vad/ort-wasm-simd-threaded.mjs`; Vite's dev server refuses to serve a
// file under /public through the module pipeline (it appends `?import` and throws
// "should not be imported from source code"), which 500s VAD init and stops a voice
// session from starting. Intercept `/vad/*` BEFORE Vite's transform middleware and
// stream the bytes with a correct content-type. DEV-ONLY: configureServer never runs
// for `vite build`, and the prod build copies public/ as-is (served statically, no
// guard) — so this changes nothing about the shipped bundle.
const serveVadAssetsRaw: PluginOption = {
  name: 'spec190-serve-vad-assets-raw',
  configureServer(server) {
    // Added in the hook body (not the returned post-hook) so it runs BEFORE Vite's
    // internal transform/public-file middlewares.
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? ''
      if (!url.startsWith('/vad/')) return next()
      const rel = url.split('?')[0] // drop ?import and friends
      const file = join(__dirname, 'public', rel)
      if (!existsSync(file)) return next()
      const ext = extname(file)
      const type =
        ext === '.mjs' || ext === '.js'
          ? 'text/javascript'
          : ext === '.wasm'
            ? 'application/wasm'
            : 'application/octet-stream' // .onnx and anything else
      res.setHeader('Content-Type', type)
      res.setHeader('Cache-Control', 'no-cache')
      createReadStream(file).pipe(res)
    })
  },
}

// VITE_API_PROXY overrides the backend target so E2E runs can point at a non-default port
// when another dev server is already holding 8080.
const API_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:8080'

// VITE_PORT lets an E2E run bind the UI dev server to a non-default port when 5173
// is already held (e.g. a stale dev server from another worktree). Playwright's
// webServer block + baseURL are wired to the same value so the suite stays
// self-consistent. Defaults to 5173 for normal `pnpm dev`.
const UI_PORT = Number(process.env.VITE_PORT ?? 5173)

export default defineConfig({
  plugins: [serveVadAssetsRaw, react()],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
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
        // spec-190 (dec-9): forward WebSocket upgrades too. The voice session WS
        // lives at /api/<ns>/<mx>/voice/session; without ws:true the dev server
        // never proxies the upgrade to the API, so the socket hangs in CONNECTING
        // and every sendAudio/endUtterance throws InvalidStateError.
        ws: true,
      },
    },
  },
})
