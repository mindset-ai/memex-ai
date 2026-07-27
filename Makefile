# ──────────────────────────────────────────────────────────────
# Memex App — Task Runner
# ──────────────────────────────────────────────────────────────
# Usage:
#   make test                Run all tests
#   make test-unit           Unit tests only (mocked, fast)
#   make test-integration    Integration tests (needs local Postgres)
#   make test-api            API / E2E tests (needs local Postgres)
#   make test-security       Security hardening tests (needs local Postgres)
#   make test-perf           Performance/concurrency tests (needs local Postgres)
#   make test-regression     Regression guards (URL shape, instructions cap, etc.)
#   make test-server         All server tests
#   make test-ui             UI unit/component tests (vitest)
#   make e2e                 Playwright e2e journeys (boots server + UI itself)
#   make e2e-cold            e2e against a throwaway freshly-migrated DB (CI parity)
#   make smoke               One-line health curl against $SMOKE_URL
#   make smoke-int           Post-deploy smoke suite against https://int.memex.ai (pure HTTP)
#   make smoke-prod          Post-deploy smoke suite against https://memex.ai (pure HTTP)
#   make smoke-int-with-db   Like smoke-int + telemetry tier (cloud-sql-proxy → mcp_tool_calls)
#   make smoke-prod-with-db  Like smoke-prod + telemetry tier
#   make dev                 Start server + UI in parallel
#   make build               Build all packages
#   make db-migrate          Run database migrations
#   make typecheck           TypeScript type checking
# ──────────────────────────────────────────────────────────────

.PHONY: test test-unit test-integration test-api test-security test-perf test-regression test-rls \
        test-server test-ui e2e e2e-cold e2e-preflight smoke smoke-int smoke-prod smoke-int-with-db smoke-prod-with-db \
        dev build db-migrate db-seed typecheck lint \
        check check-url-shape help

# ── Fast offline lane (spec-512) ─────────────────────────────

## The sub-minute guard battery: no database, no network. This is what replaces
## "push and wait for CI" as the tight feedback loop. Everything here is a pure
## static check — anything needing Postgres belongs in `make test`.
check: check-url-shape lint
	@node scripts/ci/workspace-alloc.mjs --all > /dev/null || \
		{ echo "✗ workspace allocator failed — see scripts/ci/workspace-alloc.mjs"; exit 1; }
	@echo "✓ offline guard battery passed"

# ── Tests ────────────────────────────────────────────────────

## Run all tests across all packages
test: check-url-shape test-server

## URL-shape lint (Layer B regression guard per std-2)
check-url-shape:
	node scripts/check-url-shape.mjs

## Server: unit tests only (mocked, no DB required)
test-unit:
	pnpm --filter @memex/server test:unit

## Server: integration tests (requires local Postgres)
test-integration:
	pnpm --filter @memex/server test:integration

## Server: API / E2E tests (requires local Postgres)
test-api:
	pnpm --filter @memex/server test:api

## Server: security hardening tests (auth, cross-account, injection, tokens)
test-security:
	pnpm --filter @memex/server test:security

## Server: performance/concurrency tests (requires local Postgres)
test-perf:
	pnpm --filter @memex/server test:perf

## Server: regression guards (e.g. URL shape, instructions cap, mutate coverage)
test-regression:
	pnpm --filter @memex/server test:regression

## Server: restricted-role RLS suite (spec-440) — connects the singleton AS the
## non-owner `memex_app` role so tenancy/seed writes are SUBJECT to RLS, making a
## missing app.memex_id fail in CI instead of only in prod. Requires local Postgres.
test-rls:
	pnpm --filter @memex/server test:rls

## Server: all test types
test-server:
	pnpm --filter @memex/server test

## UI: unit/component tests (vitest)
test-ui:
	pnpm --filter @memex/ui test

## UI: Playwright e2e journeys — the PR-gate tier (spec-172). Boots server (8090) + UI
## (5173) itself via the Playwright webServer block; needs local Postgres running.
## Runs against your dev DB; use e2e-cold for the CI posture. Extra args via ARGS,
## e.g. `make e2e ARGS="journey-18 --headed"`.
##
## spec-512 C1: this target gets the SAME workspace arming as e2e-cold. It was
## originally left bare, and adversarial review reproduced the original incident on
## it end-to-end: with no MEMEX_WORKSPACE_ID, playwright.config.ts falls back to the
## literal 5173/8090 AND e2e/global-setup.ts's guard early-returns (it has nothing to
## compare against), so a second worktree silently adopts the first's servers and the
## shared dev database — reporting PASS. It is the command developers run while
## iterating, so it was the most exposed target, not the least.
e2e: e2e-preflight
	MEMEX_WORKSPACE_ID="$(E2E_WS_ID)" \
		E2E_SERVER_PORT="$(E2E_API_PORT)" E2E_UI_PORT="$(E2E_UI_PORT_)" \
		pnpm --filter @memex/ui test:e2e $(ARGS)

## UI: e2e against a throwaway, freshly-migrated database — exact CI parity (std-28).
## Fast path: migrations are replayed ONCE into memex_e2e_template (rebuilt only when
## the drizzle/*.sql set changes — detected via a hash stored as the template DB's
## COMMENT), then memex_e2e is cloned from it with `createdb -T` (near-instant).
## Never touches the dev `memex` database.
## spec-512 dec-3: every e2e resource name and port is DERIVED from a hash of this
## workspace's path by the single allocator (scripts/ci/workspace-alloc.mjs), so two
## worktrees can run e2e at the same time. These used to be the literals `memex_e2e`
## and `memex_e2e_template`, which meant a second worktree's `dropdb` destroyed the
## first one's database mid-run. Overrides (E2E_DATABASE_URL, E2E_SERVER_PORT,
## E2E_UI_PORT) still win — the allocator honours them.
E2E_DB_NAME  := $(shell node scripts/ci/workspace-alloc.mjs e2e-database-name)
E2E_TPL_NAME := $(shell node scripts/ci/workspace-alloc.mjs e2e-template-name)
E2E_COLD_DB  := $(shell node scripts/ci/workspace-alloc.mjs e2e-database-url)
E2E_TPL_DB   := $(shell node scripts/ci/workspace-alloc.mjs e2e-template-url)
E2E_WS_ID    := $(shell node scripts/ci/workspace-alloc.mjs workspace-id)
E2E_API_PORT := $(shell node scripts/ci/workspace-alloc.mjs e2e-api-port)
E2E_UI_PORT_ := $(shell node scripts/ci/workspace-alloc.mjs e2e-ui-port)

e2e-cold: e2e-preflight
	@HASH=$$(cat packages/server/drizzle/*.sql | shasum -a 256 | cut -d' ' -f1); \
	CUR=$$(psql -h localhost -U postgres -At -c \
		"SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '$(E2E_TPL_NAME)'" \
		postgres 2>/dev/null); \
	if [ "$$CUR" != "$$HASH" ]; then \
		echo "⏳ (Re)building e2e template DB $(E2E_TPL_NAME) — migration set changed"; \
		dropdb --if-exists -h localhost -U postgres $(E2E_TPL_NAME) || exit 1; \
		createdb -h localhost -U postgres $(E2E_TPL_NAME) || exit 1; \
		for f in packages/server/drizzle/*.sql; do \
			psql -v ON_ERROR_STOP=1 "$(E2E_TPL_DB)" -f "$$f" > /dev/null || exit 1; \
		done; \
		psql -h localhost -U postgres -c "COMMENT ON DATABASE $(E2E_TPL_NAME) IS '$$HASH'" postgres > /dev/null || exit 1; \
	else \
		echo "✓ e2e template DB $(E2E_TPL_NAME) up to date"; \
	fi
	@# --force (spec-512): a lingering e2e server from an interrupted run holds the
	@# database and blocks a plain dropdb, aborting the whole run. The vitest tier
	@# already does this (vitest.global-setup.ts uses DROP DATABASE ... WITH FORCE);
	@# the e2e tier had not inherited it.
	dropdb --if-exists --force -h localhost -U postgres $(E2E_DB_NAME)
	createdb -h localhost -U postgres -T $(E2E_TPL_NAME) $(E2E_DB_NAME)
	DATABASE_URL="$(E2E_COLD_DB)" E2E_DATABASE_URL="$(E2E_COLD_DB)" \
		MEMEX_WORKSPACE_ID="$(E2E_WS_ID)" \
		E2E_SERVER_PORT="$(E2E_API_PORT)" E2E_UI_PORT="$(E2E_UI_PORT_)" \
		pnpm --filter @memex/ui test:e2e $(ARGS)

## Refuse to start an e2e run that would silently test the wrong code (spec-512).
## Checks: foreign server holding our port, PGPASSWORD hang, stale @memex/shared
## build, and where AC emission would land.
e2e-preflight:
	@node scripts/ci/e2e-preflight.mjs

## Smoke test — verify a running server responds (one-line health curl)
smoke:
	@echo "Smoke testing against $${SMOKE_URL:-http://localhost:8080}..."
	@curl -sf "$${SMOKE_URL:-http://localhost:8080}/api/health" | grep -q '"status":"ok"' \
		&& echo "✓ Health check passed" \
		|| (echo "✗ Health check failed" && exit 1)

## Post-deploy smoke suite vs https://int.memex.ai (b-70 — public tier always
## runs; authed tier runs only when SMOKE_MCP_TOKEN is set, else skips clean).
smoke-int:
	@set -a; ENV=int . scripts/deploy-config.sh >/dev/null; set +a; \
		SMOKE_ENV=int SMOKE_BASE_URL="https://$$PUBLIC_HOST" \
		pnpm --filter @memex/server smoke

## Post-deploy smoke suite vs https://memex.ai (prod). Same two-tier behaviour.
smoke-prod:
	@set -a; ENV=prod . scripts/deploy-config.sh >/dev/null; set +a; \
		SMOKE_ENV=prod SMOKE_BASE_URL="https://$$PUBLIC_HOST" \
		pnpm --filter @memex/server smoke

## Like smoke-int + the telemetry tier. Spins up cloud-sql-proxy so the suite
## can query mcp_tool_calls to verify telemetry actually landed for each MCP
## call. Requires the same PAM grant as `make deploy-server`.
smoke-int-with-db:
	bash packages/server/scripts/smoke-with-db.sh int

## Like smoke-prod + the telemetry tier (proxy → mcp-ai-prod Cloud SQL).
smoke-prod-with-db:
	bash packages/server/scripts/smoke-with-db.sh prod

# ── Dev ──────────────────────────────────────────────────────

## Start server + UI dev servers on this workspace's derived ports (spec-512), so
## two worktrees can run `make dev` at once. Previously hardcoded 8080/5173 with
## Vite's strictPort: true, so the second worktree's dev server exited EADDRINUSE.
## PORT / VITE_PORT still override.
DEV_API_PORT := $(shell node scripts/ci/workspace-alloc.mjs dev-api-port)
DEV_UI_PORT  := $(shell node scripts/ci/workspace-alloc.mjs dev-ui-port)
dev:
	@echo "▶ dev server  http://localhost:$(DEV_API_PORT)"
	@echo "▶ dev UI      http://localhost:$(DEV_UI_PORT)"
	MEMEX_WORKSPACE_ID="$(E2E_WS_ID)" PORT=$(DEV_API_PORT) pnpm dev:server & \
		VITE_PORT=$(DEV_UI_PORT) VITE_API_PROXY="http://localhost:$(DEV_API_PORT)" pnpm dev:ui & \
		wait

## Build all packages
build:
	pnpm build

## TypeScript type checking (no emit)
##
## spec-512: the UI half MUST use `tsc -b`, not `tsc --noEmit`.
## packages/ui/tsconfig.json is a solution-style config — `{"files": [], "references":
## [./tsconfig.app.json]}`. Plain `tsc --noEmit` honours `files: []` and therefore
## type-checks ZERO UI files, exiting 0 no matter what. Proven by planting
## `const x: number = "not a number"` in packages/ui/src/main.tsx: `tsc --noEmit`
## reported nothing; `tsc -b` caught TS2322 + TS6133 immediately.
##
## That made .husky/pre-push's "superset of the deploy's build-config type gate"
## claim false for the UI, and is the direct cause of commit 5b930ff
## ("drop unused imports the voice removal orphaned (production-build gate)").
## `tsc -b` follows the reference into tsconfig.app.json, which carries
## noUnusedLocals/noUnusedParameters — matching what CI's `build` job runs.
typecheck:
	pnpm --filter @memex/server exec tsc --noEmit
	pnpm --filter @memex/ui exec tsc -b

## Lint (Biome — curated baseline per spec-356; no reformat)
lint:
	pnpm lint

# ── Database ─────────────────────────────────────────────────

## Run database migrations
db-migrate:
	pnpm --filter @memex/server db:migrate

## Seed the database
db-seed:
	pnpm --filter @memex/server db:seed

# ── Deploy ────────────────────────────────────────────────────

## Deploy everything (server + UI) to production
deploy:
	bash deploy.sh

## Deploy server only (migrations + Cloud Run)
deploy-server:
	cd packages/server && bash deploy.sh

## Deploy UI only (build + GCS + CDN)
deploy-ui:
	cd packages/ui && bash deploy.sh

# ── Help ─────────────────────────────────────────────────────

## Show available targets
help:
	@echo "Available targets:"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'
	@echo ""
	@echo "Run 'make <target>' to execute."
