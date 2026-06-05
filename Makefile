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
#   make test-ui          All UI tests (placeholder)
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

.PHONY: test test-unit test-integration test-api test-security test-perf test-regression \
        test-server test-ui smoke smoke-int smoke-prod smoke-int-with-db smoke-prod-with-db \
        dev build db-migrate db-seed typecheck \
        check-url-shape help

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

## Server: all test types
test-server:
	pnpm --filter @memex/server test

## Admin: all tests (placeholder — no tests yet)
test-ui:
	@echo "No UI tests configured yet"

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

## Start server + UI dev servers
dev:
	pnpm dev:server & pnpm dev:ui & wait

## Build all packages
build:
	pnpm build

## TypeScript type checking (no emit)
typecheck:
	pnpm --filter @memex/server exec tsc --noEmit
	pnpm --filter @memex/ui exec tsc --noEmit

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
