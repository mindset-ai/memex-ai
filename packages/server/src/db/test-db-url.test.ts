import { describe, it, expect } from "vitest";
import { deriveTestDatabaseUrl, resolveTestDatabaseUrl } from "./test-db-url.js";

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
