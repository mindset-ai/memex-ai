// Test-database derivation (see std-9 §local development).
//
// Tests must never run against the dev database: integration/API suites
// truncate and mutate rows out from under a `make dev` server, and a branch
// with different migrations would rewrite the shared schema. Instead, vitest
// (the vitest.config.ts `env` block + vitest.global-setup.ts) rewrites
// DATABASE_URL to a per-worktree database — `<base>_test_<sha1(worktreeRoot)[0:8]>` — so the
// dev server and any number of parallel worktrees each get their own DB on
// the same local Postgres, with zero .env divergence.
//
// Escape hatch: set MEMEX_TEST_DATABASE_URL to use an exact URL verbatim.

import { createHash } from "node:crypto";

const DERIVED_SUFFIX = /_test_[0-9a-f]{8}$/;

// Pure derivation: replace the database name with `<base>_test_<hash>`,
// preserving credentials/host/port/query. Idempotent on already-derived URLs.
export function deriveTestDatabaseUrl(
  baseUrl: string,
  worktreeRoot: string,
): string {
  const url = new URL(baseUrl);
  const baseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (DERIVED_SUFFIX.test(baseName)) return baseUrl;
  // Postgres identifiers cap at 63 chars; sanitised base (≤40) + suffix (14) fits.
  const safeBase =
    (baseName || "memex").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
  const hash = createHash("sha1").update(worktreeRoot).digest("hex").slice(0, 8);
  url.pathname = `/${safeBase}_test_${hash}`;
  return url.toString();
}

// Env-aware resolution used by both vitest.config.ts (worker env override)
// and vitest.global-setup.ts (create/migrate) so they always agree on the
// same database.
export function resolveTestDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
  worktreeRoot: string = process.cwd(),
): string {
  if (env.MEMEX_TEST_DATABASE_URL) return env.MEMEX_TEST_DATABASE_URL;
  const base =
    env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex";
  return deriveTestDatabaseUrl(base, worktreeRoot);
}
