# Security + performance hardening tests

Integration tests that exercise the multi-tenancy isolation, authentication, injection,
token handling, and concurrency guarantees **end-to-end through the full Hono app**
(not against isolated services). Paired with the sibling `__perf__/` tier for
load/concurrency work.

## Running

```bash
# Everything that needs local Postgres
pnpm --filter @memex/server test:security    # 19 tests, ~2s
pnpm --filter @memex/server test:perf        # 7 tests, ~2s

# Equivalent via Makefile
make test-security
make test-perf
```

Both tiers require a running local Postgres (`brew services start postgresql@16`) and
`DATABASE_URL=postgresql://postgres:postgres@localhost:5432/memex`.

## What's covered

### `auth.security.test.ts` — production-mode authentication
- Missing Authorization header → 401
- Malformed JWT (signature verify throws) → 401
- Valid token, user not in DB → 401 (deleted-user replay)
- Active user but disabled status → 403
- Active user, not a tenant member → 403
- Regular member hitting an admin-only route → 403
- Unverified email (`email_verified: false`) → 403

Runs prod-mode by setting `GOOGLE_CLIENT_ID` and mocking `google-auth-library`'s
`OAuth2Client` at the top of the file so `sessionMiddleware` takes the verification
branch.

### `cross-account.security.test.ts` — tenant isolation
- Cross-tenant UUID fetch returns 404 (not 403 — no existence leak)
- Per-account handle resolution doesn't cross tenants
- Share-token payload carries the token's real account; body `X-Memex-Account-Id` header is ignored
- Revoked share tokens return 410 on replay
- `/api/docs` lists only the current tenant's docs

### `injection.security.test.ts` — injection & validation
- SQL-injection subdomain rejected at the format-check layer
- JSON/SQL injection via `emailDomains` field doesn't corrupt the DB
- XSS payload in doc title round-trips verbatim (server stores as-is; React layer
  sanitizes on render via `react-markdown` + `rehype-sanitize`)

### `tokens.security.test.ts` — token entropy & replay
- Invite, share, and domain-verification tokens are UUID v4 (122 bits entropy ≫ brute-force ceiling)
- Replay of an unknown token returns 404
- Replay of a revoked share token returns 410
- Invite tokens cannot be reclaimed by a second user after first consumption

### `__perf__/signup.perf.test.ts` — account creation concurrency
- 100 concurrent unique-subdomain signups all succeed
- 50 concurrent same-subdomain signups: exactly 1 wins, 49 receive `ConflictError`

### `__perf__/invites.perf.test.ts` — invite-token concurrency
- 20 admins generating invites concurrently produce 20 distinct UUIDs
- 10 users claiming the same invite: 1 wins, 9 receive `used` error

### `__perf__/queries.perf.test.ts` — account-scoped query scale
- `listDocs` over a target tenant with 500 docs (amid 10 noise tenants × 100 docs each)
  completes under 500ms and returns only the target's rows

### `__perf__/cleanup.perf.test.ts` — background job idempotency
- 10K expired invite tokens drain under 5s; two concurrent workers partition the work
  without double-delete
- Domain-verification cleanup is safe to run concurrently across replicas

## Known gaps

These are deliberate scope decisions, not oversights — each is listed here so reviewers
and future hardening work know what's NOT covered:

1. **No rate limiting.** The server has no per-IP or per-user rate limit on token
   endpoints (`/api/invites`, `/api/share/*`, `/api/accounts/check-subdomain`). A
   determined attacker could enumerate subdomains or attempt brute-force token guessing.
   UUID v4 entropy makes guessing infeasible (~2^122 search space), but sustained
   request volume can still DoS the Cloud Run instance. **Next step:** Cloud Armor or
   Hono rate-limit middleware in front of unauthenticated endpoints.

2. **No CSRF protection on cookie flows.** Currently all writes authenticate via Bearer
   tokens, so CSRF isn't exploitable today. If cookies are ever introduced (e.g., for
   the marketing site login), add a double-submit token or SameSite=Strict cookie gate.

3. **Share tokens don't expire.** Unlike invite and domain-verification tokens (which
   carry `expiresAt`), share tokens only have `revoked: boolean`. Long-lived links are
   intentional — shared docs shouldn't silently break — but an admin who revokes
   membership for a user can't also revoke any share links that user previously
   received. **Next step:** per-share-token TTL + a "revoke all from user" admin action.

4. **No timing-attack hardening on token lookup.** `db.query.inviteTokens.findFirst({
   where: eq(token, ...) })` runs in non-constant time depending on whether a row
   exists. For UUID v4 tokens this is not exploitable (the attacker still needs to guess
   the full token), but a defense-in-depth constant-time comparison on lookup would
   close the theoretical side-channel.

5. **OAuth token replay window.** Google ID tokens are accepted until their `exp` (≤1h).
   If a token leaks, the attacker has up to the remaining lifetime. We don't track
   `jti` to reject known-leaked tokens. Mitigated by short TTL and HTTPS-only
   transport.

6. **Concurrent admin-demotion race.** `updateMembershipRole` checks "at least one admin
   remains" but doesn't `SELECT FOR UPDATE`. Two admins demoting each other in the same
   millisecond can both pass the guard and leave an account with zero admins.
   Flagged in the t-14 comments on Memex; invariant-violation detection is in the
   test suite but row-locking fix is deferred.

## Test conventions

- **File naming**: `*.security.test.ts` → security suite; `*.perf.test.ts` → perf suite.
  The default `test:unit` script excludes both so unit-only runs stay DB-free.
- **DB cleanup**: Every test file tracks its seeded `accountIds` + `userIds` and runs
  `afterAll` cascade deletes. Seeded `dev@memex.ai` is wiped of memberships in each
  setup to prevent cross-test state bleed.
- **Mocking OAuth**: `auth.security.test.ts` sets `GOOGLE_CLIENT_ID` and mocks
  `google-auth-library` at module-load time via `vi.hoisted`. Other security files run
  dev-mode so `dev@memex.ai` is auto-authenticated; they explicitly `delete
  process.env.GOOGLE_CLIENT_ID` in `beforeAll` to guarantee that state.
