import { defineConfig, devices } from "@playwright/test";

// t-15 E2E test config. Runs in dev mode (no GOOGLE_CLIENT_ID) so AuthContext uses the
// hardcoded dev@memex.ai fallback — the admin never hits the Google login screen. Multi-user
// journeys seed additional users in the DB directly via the e2e helpers.
//
// Environment variables (optional):
//   E2E_BASE_URL     — admin URL (default http://localhost:5173)
//   E2E_API_URL      — API URL (default http://localhost:8090)
//   E2E_DATABASE_URL — Postgres DSN for seeding (default postgres://postgres:postgres@localhost:5432/memex)
//   E2E_SKIP_WEBSERVER=1 — skip auto-starting server+admin (useful when they're already running)

const ADMIN_PORT = 5173;
// Use 8090 by default so E2E can coexist with a dev server already on 8080. Vite reads
// VITE_API_PROXY to forward /api/* to this port.
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 8090);
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/memex";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // tests mutate shared DB; run serially to avoid cross-test pollution
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${ADMIN_PORT}`,
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : [
        {
          // GOOGLE_CLIENT_ID is explicitly unset so sessionMiddleware takes the dev-user
          // bypass; otherwise packages/server/.env would leak into the test run and every
          // request would 401 without a real Google token.
          //
          // NOTE: Stop any locally-running `make dev` before running E2E — a reused server
          // that has GOOGLE_CLIENT_ID set (from .env) will render the LoginScreen instead of
          // the dev-user auto-bootstrap the tests depend on.
          // MEMEX_ANTHROPIC_FAKE=1 swaps the Anthropic SDK for a deterministic in-memory
          // double; Playwright drives its queue via POST /api/__test__/anthropic-queue.
          // See packages/server/src/agent/anthropic-fake.ts.
          command: `GOOGLE_CLIENT_ID="" MEMEX_ANTHROPIC_FAKE=1 DATABASE_URL="${DATABASE_URL}" PORT=${SERVER_PORT} pnpm --filter @memex/server dev`,
          url: `http://localhost:${SERVER_PORT}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          stdout: "ignore",
          stderr: "pipe",
        },
        {
          // Same rationale for VITE_GOOGLE_CLIENT_ID on the admin side — the AuthContext
          // auto-bootstraps a dev session only when this env var is empty.
          command: `VITE_GOOGLE_CLIENT_ID="" VITE_API_PROXY="http://localhost:${SERVER_PORT}" pnpm --filter @memex/ui dev`,
          url: `http://localhost:${ADMIN_PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          stdout: "ignore",
          stderr: "pipe",
        },
      ],
});
