# End-to-end tests

Playwright browser journeys driving the post-0038 product against a throwaway local
stack — the **PR-gate e2e tier** (the merge-side counterpart of the std-17 post-deploy
smoke tier). Rebuilt under spec-172.

## Running

```bash
make e2e                                      # full suite (chromium), against your dev DB
make e2e ARGS="journey-18 --headed"           # single file, watching the browser
make e2e-cold                                 # throwaway freshly-migrated DB — exact CI parity
pnpm --filter @memex/ui test:e2e --ui         # interactive runner
```

Playwright boots both the server (`http://localhost:8090`) and UI (`http://localhost:5173`)
via its `webServer` block, then runs `globalSetup`. Postgres must already be running
(`brew services start postgresql@16`).

## Running locally — first-run gotchas

CI does these steps for you; a fresh local checkout does not. If `make e2e-cold` seems to
hang, or **every** journey fails identically, it's almost always one of these — not your
test.

- **`PGPASSWORD` for the cold-DB rebuild.** `make e2e-cold` rebuilds the
  `memex_e2e_template` DB whenever the `drizzle/*.sql` set changes (e.g. a branch that adds
  a migration). Its `dropdb`/`createdb` steps don't carry a password — unlike the `psql -f`
  steps, which embed it in the URL — so on a Postgres that requires auth they block on a
  hidden `Password:` prompt **with zero output** (looks like a slow build; hangs forever).
  Run it as `PGPASSWORD=postgres make e2e-cold`.
- **Rebuild `@memex/shared` after a branch switch.** The UI imports `@memex/shared` from its
  prebuilt `dist/`, not the TS source. A stale `dist` (missing an export the UI now imports)
  throws a module-load `SyntaxError` → React never mounts → **blank page on every route →
  every journey fails identically** with a generic "heading not found" timeout. Run
  `pnpm --filter @memex/shared build` first. The `SyntaxError` is only visible in `trace.zip`,
  not the screenshot.
- **Install the browser.** `make e2e-cold` doesn't. A fresh checkout or a bumped Playwright
  version fails at `browserType.launch` ("Executable doesn't exist") until you run
  `pnpm exec playwright install chromium`.
- **`MEMEX_EMIT=false` for dry runs.** Otherwise a journey's `afterEach` POSTs real
  `test_events` to the AC ref's canonical host (prod `memex.ai` for `mindset-prod/...` refs).
  Set `MEMEX_EMIT=false` when running locally just to confirm a journey is green.

**Diagnosis shortcut:** when a journey fails, run a known-good one (e.g.
`make e2e-cold ARGS="journey-10-primary-nav"`). If *it* fails identically, the problem is
environmental, not your spec — stop debugging the test and read `trace.zip` (console +
network), where the real error lives. A blank page with **no `/api/*` calls** in the trace
means the app crashed before bootstrap (almost always the stale-`dist` `SyntaxError` above).

## The foundation (spec-172)

The e2e package has **no Postgres / SQL dependency**. All seeding, reads, and cleanup go
over HTTP to the server's env-gated test-only router (`packages/server/src/routes/__test__.ts`,
mounted at `/api/__test__` only when `MEMEX_ANTHROPIC_FAKE=1`). Those endpoints call the
server's **real services**, so seeded mutations emit on the unified bus [per std-8] — the
SSE-reactive UI under test sees seeded data the way it sees real data — and any schema
drift breaks the *server* build loudly instead of rotting silently here (the failure mode
that motivated the rebuild, dec-2).

| Helper module | What it gives journeys |
|---|---|
| `helpers/seed.ts` | HTTP clients of `/api/__test__`: `getPersonalMemexByEmail`, `ensureUser`, `setUserName`, `clearUserName`, `seedSpecInMemex`, `deleteDoc`, `clearOrgMemberships`, `cleanup`. |
| `helpers/fixtures.ts` | The per-test `test`/`expect`, path-based URL helpers (`tenantPath`, `bareUrl`), unique `slug`/`email` factories, resource tracking + afterEach cleanup, and per-test dev-user baseline reset. |
| `helpers/emit-ac.ts` | `emitAcEvents(...)` — ports the AC-emission wire format to Playwright (the suite isn't wired to `@memex-ai-ac/vitest`). |
| `helpers/index.ts` | Barrel — import everything from `./helpers/index.js`. |

### URL helpers are path-based [per std-2]

Tenant navigation is **path-based on the single origin** — `/<namespace>/<memex>/...`.
There is no subdomain form; the account-era `tenantUrl` (which built `<sub>.host`) was
removed with the account-era journeys (dec-1).

```ts
tenantPath("acme", "main", "/specs")  // → http://localhost:5173/acme/main/specs
bareUrl("/invite/abc")                // → http://localhost:5173/invite/abc
```

### Per-test fixture

`helpers/fixtures.ts` re-asserts the dev-user baseline **before each test**: ensures
`dev@memex.ai` exists with its personal namespace/memex, drops every org membership
(stale team rows would skew the switcher/router), and re-sets the display name (so a
journey that cleared it — onboarding — can't leak a nameless user forward). After each
test it tears down tracked namespaces (via `resources.slug(...)`) and loose docs.

## Cold-start posture — globalSetup (dec-3)

`playwright.config.ts` declares a `globalSetup` (`e2e/global-setup.ts`) that runs **once
per suite, after the webServer boots** (Playwright starts webServers before globalSetup).
It ensures `dev@memex.ai` exists **with a display name** before any journey runs, so a
cold, freshly-migrated CI database doesn't route every journey into Onboarding. The
onboarding screen keeps explicit coverage via the lifecycle-spine signup leg — a freshly
signed-up user is nameless, so the name step renders for real — with
`verify-spec-172-setup.spec.ts` as the complementary "named by default" check (ac-10).

## How tests authenticate

The suite runs against **dev mode** — `GOOGLE_CLIENT_ID` is unset, so token-less requests
resolve to the dev user `dev@memex.ai` without a real Google token, and `AuthContext`
bootstraps a real dev session. A presented **valid session JWT wins over the dev bypass**
(spec-172 issue-1 fix in `session.ts#resolveBearerUser`), which is what lets the
lifecycle-spine journey (t-7) sign up a *new* user via native auth [per std-13] and drive
the browser as that user.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `E2E_SERVER_PORT` | `8090` | API port the server binds to during E2E runs (non-default so tests coexist with a dev server on 8080). |
| `E2E_API_URL` | `http://localhost:8090` | Server origin the `helpers/seed.ts` HTTP clients hit. |
| `E2E_BASE_URL` | `http://localhost:5173` | UI origin used by `tenantPath` / `bareUrl`. |
| `E2E_SKIP_WEBSERVER` | unset | Set to `1` when server + UI are already running and Playwright shouldn't start them. |
| `MEMEX_EMIT_KEY` | unset | Per-Memex emission key (Bearer) for AC `test_events` (CI secret). Missing key ⇒ ACs stay unverified, never a test failure. |

Vite reads `VITE_API_PROXY` to forward `/api/*` to `E2E_SERVER_PORT`; the `test:e2e`
command wires this up automatically.

## Adding a new journey

1. Create `journey-N-<slug>.spec.ts` (or `verify-spec-N-*.spec.ts`) in this directory.
2. `import { test, expect, tenantPath, bareUrl } from "./helpers/index.js"`.
3. Seed preconditions via the `helpers/seed.ts` HTTP helpers — **never** raw SQL. Track
   created namespaces with `resources.slug(prefix)` so afterEach cleans them up.
4. Navigate path-based via `tenantPath(ns, mx, path)` [per std-2] — no subdomains.
5. Keep tests serial — `workers: 1`, `fullyParallel: false` (one shared Postgres).
6. If the journey verifies an AC, tag it via `emitAcEvents([...], status, id, dur)` in an
   `afterEach`, following the ac-emission discipline (pass AND fail).

## Debugging failures

- `test-results/<name>/video.webm` — full video of the run
- `test-results/<name>/trace.zip` — open with `pnpm exec playwright show-trace <path>`
- `test-results/<name>/error-context.md` — Playwright auto-summary with DOM snapshot
