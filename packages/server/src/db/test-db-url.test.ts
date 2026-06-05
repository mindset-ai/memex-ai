import { describe, it, expect } from "vitest";
import {
  deriveTestDatabaseUrl,
  deriveWorkerDatabaseUrl,
  resolveTestDatabaseUrl,
  TEST_MAX_WORKERS,
} from "./test-db-url.js";

const BASE = "postgresql://postgres:postgres@localhost:5432/memex";

describe("deriveTestDatabaseUrl", () => {
  it("appends _test_<8-hex-hash> to the database name", () => {
    const derived = deriveTestDatabaseUrl(BASE, "/Users/dev/memex-app");
    expect(new URL(derived).pathname).toMatch(/^\/memex_test_[0-9a-f]{8}$/);
  });

  it("is deterministic for the same worktree and distinct across worktrees", () => {
    const a1 = deriveTestDatabaseUrl(BASE, "/Users/dev/memex-app");
    const a2 = deriveTestDatabaseUrl(BASE, "/Users/dev/memex-app");
    const b = deriveTestDatabaseUrl(BASE, "/Users/dev/worktrees/spec-150");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("preserves credentials, host, port, and query params", () => {
    const derived = new URL(
      deriveTestDatabaseUrl(
        "postgresql://user:pw@db.internal:6543/memex?sslmode=disable",
        "/wt",
      ),
    );
    expect(derived.username).toBe("user");
    expect(derived.password).toBe("pw");
    expect(derived.hostname).toBe("db.internal");
    expect(derived.port).toBe("6543");
    expect(derived.searchParams.get("sslmode")).toBe("disable");
  });

  it("is idempotent on an already-derived URL", () => {
    const once = deriveTestDatabaseUrl(BASE, "/wt");
    expect(deriveTestDatabaseUrl(once, "/some/other/path")).toBe(once);
  });

  it("sanitises awkward database names and stays under the 63-char identifier cap", () => {
    const derived = deriveTestDatabaseUrl(
      `postgresql://localhost:5432/${"My-Weird.Name!".repeat(5)}`,
      "/wt",
    );
    const name = new URL(derived).pathname.slice(1);
    expect(name).toMatch(/^[a-z0-9_]+_test_[0-9a-f]{8}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("deriveWorkerDatabaseUrl", () => {
  const TEST_URL = deriveTestDatabaseUrl(BASE, "/wt");

  it("appends _w<poolId> to the test database name", () => {
    const derived = deriveWorkerDatabaseUrl(TEST_URL, "3");
    expect(new URL(derived).pathname).toMatch(/^\/memex_test_[0-9a-f]{8}_w3$/);
  });

  it("is idempotent — setup files re-run per test file under isolation", () => {
    const once = deriveWorkerDatabaseUrl(TEST_URL, "3");
    expect(deriveWorkerDatabaseUrl(once, "5")).toBe(once);
  });

  it("preserves credentials, host, port, and query params", () => {
    const derived = new URL(
      deriveWorkerDatabaseUrl(
        "postgresql://user:pw@db.internal:6543/memex_test_0a1b2c3d?sslmode=disable",
        "2",
      ),
    );
    expect(derived.username).toBe("user");
    expect(derived.password).toBe("pw");
    expect(derived.hostname).toBe("db.internal");
    expect(derived.port).toBe("6543");
    expect(derived.searchParams.get("sslmode")).toBe("disable");
    expect(derived.pathname).toBe("/memex_test_0a1b2c3d_w2");
  });

  it("stays under the 63-char identifier cap on a max-length test-db name", () => {
    const longBase = `postgresql://localhost:5432/${"x".repeat(64)}`;
    const testUrl = deriveTestDatabaseUrl(longBase, "/wt");
    const worker = deriveWorkerDatabaseUrl(testUrl, String(TEST_MAX_WORKERS));
    expect(new URL(worker).pathname.slice(1).length).toBeLessThanOrEqual(63);
  });

  it("sanitises a non-numeric pool id rather than producing an invalid name", () => {
    const derived = deriveWorkerDatabaseUrl(TEST_URL, "weird;id");
    expect(new URL(derived).pathname).toMatch(/_w0$/);
  });
});

describe("TEST_MAX_WORKERS", () => {
  it("is at least 1 and capped at 8 (connection budget, see comment in module)", () => {
    expect(TEST_MAX_WORKERS).toBeGreaterThanOrEqual(1);
    expect(TEST_MAX_WORKERS).toBeLessThanOrEqual(8);
  });
});

describe("resolveTestDatabaseUrl", () => {
  it("uses MEMEX_TEST_DATABASE_URL verbatim when set", () => {
    const explicit = "postgresql://localhost:5432/my_exact_db";
    expect(
      resolveTestDatabaseUrl(
        { MEMEX_TEST_DATABASE_URL: explicit, DATABASE_URL: BASE },
        "/wt",
      ),
    ).toBe(explicit);
  });

  it("derives from DATABASE_URL when set", () => {
    const resolved = resolveTestDatabaseUrl({ DATABASE_URL: BASE }, "/wt");
    expect(resolved).toBe(deriveTestDatabaseUrl(BASE, "/wt"));
  });

  it("falls back to the std-9 local default when DATABASE_URL is unset", () => {
    const resolved = new URL(resolveTestDatabaseUrl({}, "/wt"));
    expect(resolved.hostname).toBe("localhost");
    expect(resolved.port).toBe("5432");
    expect(resolved.pathname).toMatch(/^\/memex_test_[0-9a-f]{8}$/);
  });
});
