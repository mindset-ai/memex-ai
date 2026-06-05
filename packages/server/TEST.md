# Server tests

This document explains how the `@memex/server` test suite is structured, how to run
each tier, what the seeding helpers do, and where the known coverage gaps are.

## At a glance

| Tier | Command | Needs DB? | Typical runtime | When to run |
|------|---------|-----------|-----------------|-------------|
| Unit | `pnpm test:unit` | No | <2s | After every code change |
| Integration | `pnpm test:integration` | Yes | ~8s | Before opening a PR |
| API / E2E | `pnpm test:api` | Yes | ~4s | Before opening a PR |
| Security | `pnpm test:security` | Yes | ~2s | Before opening a PR |
| Regression | `pnpm test:regression` | Yes | ~1s | After migrations / FK changes |
| Performance | `pnpm test:perf` | Yes | ~2s | Nightly (CI) or after concurrency-sensitive changes |
| Coverage | `pnpm test:coverage` | Yes | ~20s | Before opening a PR; enforced by CI |
| All | `pnpm test` | Yes | ~20s | Release gate |
| Watch | `pnpm test:watch` | Varies | — | Local dev iteration |

Every `*` script that needs a DB picks up `DATABASE_URL` from the environment. The
Makefile wrappers (`make test-unit`, `make test-integration`, …) pin the tier names.

## Prerequisites

- PostgreSQL 16 running locally: `brew services start postgresql@16`
- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/memex` in your shell env
  (or `.env` file next to `packages/server/package.json`)
- Migrations applied: `pnpm --filter @memex/server db:migrate` (journal-tracked
  files), plus any hand-written `0009+` files via `psql -f`. See
  [drizzle README](./drizzle) for the gotchas.

In CI a fresh Postgres side-car is provisioned and all `drizzle/*.sql` files are piped
in sequence — no separate migrate step needed. See `.github/workflows/test.yml`.

## File-naming conventions

The suite is sliced by file-name suffix rather than directory so the same service can
own unit, integration, and security tests side-by-side:

- `*.test.ts` — unit tests. Pure functions, mocked dependencies, no network or DB.
- `*.integration.test.ts` — hits the real Postgres. Each file manages its own seed + cleanup.
- `*.api.test.ts` — full HTTP round-trip via `app.request()` with seeded tenant state.
- `*.security.test.ts` — defense-in-depth end-to-end checks (see `src/__security__/`).
- `*.perf.test.ts` — concurrency / query-scale tests (see `src/__perf__/`).
- `*.regression.test.ts` — protects invariants across migrations (see `src/__regression__/`).

`test:unit` excludes every `integration`/`api`/`security`/`perf`/`regression` suffix so
you can iterate quickly without a DB running.

## Seeding helpers

Shared across every DB-aware tier. Defined in `src/services/test-helpers.ts` — prefer
these to raw inserts so schema changes land in one place.

### `makeTestMemex(prefix = "ta")`
Inserts a namespace + org + memex with a unique slug (`${prefix}-<base36-ts>-<rand>`)
and returns the memex UUID. No memberships, no docs. Use when you need a tenant but
will seed the rest yourself.

### `makeTestMemexWithDevAdmin(prefix = "ta")`
Same as above, plus upserts `dev@memex.ai` and enrolls them as `administrator` of the
org. Returns `{ memexId, slug }` (slug is the namespace slug; the memex slug is always
`"main"`). Use for route tests that need `sessionMiddleware` to auto-authenticate
(dev-mode) with membership context. The path-based router reads tenancy from the URL
path, so tests target the canonical `/api/<ns>/<mx>/...` shape:
```ts
const { memexId, slug } = await makeTestMemexWithDevAdmin("my-test");
const res = await app.request(`/api/${slug}/main/docs`);
```

### Ad-hoc seeding
For invites / share tokens / docs / etc., call the service functions directly:
- `createDocDraft(accountId, title, purpose)` — creates doc + first section atomically
- `createInviteToken(accountId)` — 7-day TTL, per dec-2
- `createShareToken(accountId, docId)` — no TTL, revocable
- `createDomainVerificationToken(accountId, domain)` — 24-hour TTL
- `upsertUserByEmail(email)` — idempotent user row

Every file should track the IDs it seeds and clean up in `afterAll`:
```ts
const accountIds: string[] = [];
afterAll(async () => {
  await db.delete(accounts).where(inArray(accounts.id, accountIds)).catch(() => {});
});
```
The `catch(() => {})` absorbs a test that aborted mid-setup and already cleaned up.

### The dev user's membership state is global
`sessionMiddleware` always resolves to `dev@memex.ai` in dev mode, so if test A leaves
the dev user as a member of its tenant, test B's 403-on-non-member check will
accidentally pass for the wrong reason. Each setup function that needs a clean slate
should explicitly:
```ts
await db.delete(accountMemberships).where(eq(accountMemberships.userId, devUser.id));
```
Then re-insert only the membership the test requires. See
`src/routes/invites.integration.test.ts::setupAccount` for the canonical pattern.

## Running individual tests

Vitest accepts path fragments and test-name filters:
```bash
pnpm --filter @memex/server exec vitest run src/services/accounts          # one dir
pnpm --filter @memex/server exec vitest run accounts.integration           # one file
pnpm --filter @memex/server exec vitest run -t "cascades"                  # name filter
```

## Coverage

```bash
pnpm --filter @memex/server test:coverage
open packages/server/coverage/index.html
```

Gated on `src/services/**/*.ts` only — route handlers, middleware, the AI agent, and
MCP tools are excluded. The thresholds in `vitest.config.ts`:

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Lines | 80% | Standard bar; reflects services coverage goal from t-17 AC |
| Statements | 80% | Same |
| Functions | 80% | Same |
| Branches | 70% | Held below lines/statements because defensive branches (e.g., error paths in `shared/blockers.ts`) only register if the file is directly unit-tested, not transitively via route tests that mock it. Raise as direct unit coverage lands. |

Low-coverage files visible in the report — treat these as known gaps:

- `services/shared/blockers.ts` (0% direct): exercised via route tests that mock it.
- `services/email/sender.ts` (33%): console/not-configured senders are thin wrappers
  over `console.log` and a no-op.
- `services/waitlist.ts` (11%): helpers for future analytics that aren't called yet.
- `services/tasks.ts::updateTaskStatus` branch coverage (~68%): several status-transition
  edge cases lack direct tests; the routes test covers the happy path.
- `services/auth.ts` (70%): the tenant-override + referral-attribution branches only fire
  on the dec-13 signup flows, which the admin E2E (t-15) covers indirectly.

## Known coverage gaps

These are deliberately deferred; listed here so reviewers know they're known:

1. **Agent, MCP, and route handlers**: excluded from the coverage gate because they're
   predominantly orchestration — their correctness is proven by the routes' own
   integration tests, not line coverage.
2. **Concurrent admin-demotion race** (see t-14 comment on Memex): two admins demoting
   each other simultaneously can both pass the last-admin check. Needs
   `SELECT FOR UPDATE` inside `updateMembershipRole` — deferred.
3. **Rate limiting**: no tests because there's no implementation. See
   `src/__security__/README.md` for the full list of security gaps.
4. **Pre-multitenancy data**: the t-9 backfill path is tested via the integration suite,
   but we don't have a "run on a dataset that predates 0011_add_multi_tenancy" regression
   because dev DBs are recreated from scratch. If a production incident ever surfaces
   here, write a dedicated migration-replay test and link it from this bullet.

## CI pipeline

See `.github/workflows/test.yml`. Summary:

- **Every PR + push to main** (`test` job): unit + integration + security + regression +
  coverage gate + admin unit tests. Postgres 16 side-car. Expected runtime ~3 min.
- **Every PR + push to main** (`e2e` job, depends on `test`): Playwright chromium
  against a fresh DB via the webServer block. ~4 min.
- **Nightly at 06:00 UTC** (`perf` job): concurrency / scale tests. Not on PRs to keep
  reviewer feedback fast. Can be triggered manually via
  `gh workflow run test.yml --ref <branch>`.

Artifacts uploaded:
- `server-coverage` — always uploaded so threshold failures can be diagnosed
- `playwright-traces` — uploaded only on E2E failure

## Adding new tests

1. Pick the suffix (see [File-naming conventions](#file-naming-conventions))
2. Prefer `makeTestAccountWithDevAdmin` unless the test specifically needs an account
   that `dev@memex.ai` is NOT a member of
3. Track every seeded ID and clean up in `afterAll` with `.catch(() => {})`
4. For concurrency-sensitive assertions, use `Promise.allSettled` + partition by
   `status === "fulfilled" | "rejected"` rather than awaiting sequentially
5. If you introduce a new `pgTable`, add its name to
   `src/__regression__/schema-state.regression.test.ts::EXPECTED_TABLES` so the
   schema-drift test catches missing migrations
