# End-to-end tests

Playwright browser tests covering the seven multi-tenancy journeys: account creation,
team invites, auto-grouping, multi-account switching, external sharing, member management,
and domain-conflict handling.

## Running

```bash
pnpm --filter @memex/admin test:e2e              # full suite (chromium)
pnpm --filter @memex/admin test:e2e journey-1    # single file
pnpm --filter @memex/admin test:e2e --ui         # interactive runner
```

Playwright boots both the server (`http://localhost:8090`) and admin (`http://localhost:5173`)
via its `webServer` block. Postgres must already be running (`brew services start postgresql@16`).

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `E2E_SERVER_PORT` | `8090` | API port the server binds to during E2E runs. Non-default so tests coexist with a dev server on 8080. |
| `E2E_BASE_URL` | `http://localhost:5173` | Admin URL used by `tenantUrl`/`bareUrl` helpers. |
| `E2E_DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/memex` | DSN for direct-seed helpers. |
| `E2E_SKIP_WEBSERVER` | unset | Set to `1` when the server + admin are already running and Playwright shouldn't start them. |

Vite reads `VITE_API_PROXY` to forward `/api/*` to `E2E_SERVER_PORT`; the `test:e2e` command
wires this up automatically.

## How tests authenticate

The tests run against **dev mode** — `GOOGLE_CLIENT_ID` is unset so the server accepts the
dev user `dev@memex.ai` without a real Google token. `AuthContext` detects dev mode and
bootstraps a real session via `POST /api/auth/sso/google` with an empty `idToken`.

Before each test, `helpers/fixtures.ts` clears any existing memberships for `dev@memex.ai`
so the `PostLoginRouter` routing decision is deterministic (signup vs. picker vs.
auto-redirect). Multi-user journeys (invites, member management) seed additional users
directly in the database via `helpers/db.ts`.

## Dev-mode caveat

Because there is only one "real" logged-in identity, scenarios that depend on *two humans*
acting concurrently (e.g., "Alice invites Bob, Bob clicks, Bob fills signup") are simulated
by acting on the database while continuing to log in as dev@memex.ai. The UI surface is
exercised end-to-end; the cross-user identity switch is not.

To extend for real SSO:

1. Generate a long-lived service-account ID token (or mint a test-mode JWT accepted by a
   test-only verifier in `middleware/session.ts`).
2. Pass the token via `Authorization: Bearer` in a Playwright `page.route` hook.
3. Swap `helpers/fixtures.ts` `devAsAdmin` for `seedUser(email); seedMembership(userId, ...)`
   per identity and set the Bearer token at the start of each journey.

## Adding a new journey

1. Create `journey-N-<slug>.spec.ts` in this directory.
2. Import `test`, `expect`, `tenantUrl`, `bareUrl` from `./helpers/fixtures.js`.
3. Use `seedAccount`, `seedUser`, `seedMembership`, etc. from `./helpers/db.js` to set up
   preconditions. Push every created `accountId` onto `resources.accountIds` so teardown
   cascades the cleanup.
4. Keep tests serial — `playwright.config.ts` sets `workers: 1` and `fullyParallel: false`
   because all tests share one Postgres instance.

## Debugging failures

- `test-results/<name>/video.webm` — full video of the run
- `test-results/<name>/trace.zip` — open with `pnpm exec playwright show-trace <path>`
- `test-results/<name>/error-context.md` — Playwright auto-summary with DOM snapshot
- Add `page.on('console', ...)` inside a spec to surface browser console logs
