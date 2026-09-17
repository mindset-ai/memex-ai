import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import postgres from "postgres";
import {
  deriveTestDatabaseUrl,
  deriveWorkerDatabaseUrl,
  resolveTestDatabaseUrl,
  TEST_MAX_WORKERS,
} from "./test-db-url.js";

const BASE = "postgresql://postgres:postgres@localhost:5432/memex";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-524/acs/ac-${n}`;

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

  // spec-524 dec-7 replaced this test's original assertion. It used to pin
  // `port === "5432"`, which was the literal this Spec exists to remove: the
  // server tier guessed the same value the allocator guessed, and a worktree
  // with no packages/server/.env died inside migration 0023 on a Postgres 14
  // that happened to hold 5432. The url now carries no port, and the driver
  // that owns the default resolves it.
  it("emits NO port when DATABASE_URL is unset, so the driver resolves it (ac-9, ac-22)", () => {
    tagAc(AC(9));
    tagAc(AC(22));
    const url = resolveTestDatabaseUrl({}, "/wt");
    const resolved = new URL(url);
    expect(resolved.port).toBe("");
    expect(resolved.hostname).toBe("localhost");
    expect(resolved.pathname).toMatch(/^\/memex_test_[0-9a-f]{8}$/);

    // ac-9 claims the resolver still REACHES localhost:5432, not merely that
    // the string lost its port. Ask the driver where it would land rather than
    // restating the default ourselves — it is the component that owns it, and a
    // second opinion here would be the defect this Spec removes. Reading
    // `.options` parses the url without opening a socket.
    expect(postgres(url, { max: 1 }).options.port).toEqual([5432]);
    expect(
      postgres(resolveTestDatabaseUrl({ PGPORT: "5433" }, "/wt"), { max: 1 })
        .options.port,
    ).toEqual([5433]);
  });

  it("PGPORT and PGHOST steer the resolved url (ac-7)", () => {
    tagAc(AC(7));
    const byPort = new URL(resolveTestDatabaseUrl({ PGPORT: "5433" }, "/wt"));
    expect(byPort.port).toBe("5433");
    const byHost = new URL(
      resolveTestDatabaseUrl({ PGHOST: "db.internal" }, "/wt"),
    );
    expect(byHost.hostname).toBe("db.internal");
  });

  it("naming the server does not rename the database (ac-8)", () => {
    tagAc(AC(8));
    const withServer = new URL(
      resolveTestDatabaseUrl({ PGPORT: "5433", PGHOST: "db.internal" }, "/wt"),
    );
    const plain = new URL(resolveTestDatabaseUrl({}, "/wt"));
    expect(withServer.pathname).toBe(plain.pathname);
  });

  it("an explicit DATABASE_URL still wins outright over PGHOST/PGPORT (ac-10)", () => {
    tagAc(AC(10));
    // DATABASE_URL names the whole server, so it is the stronger statement.
    // dec-2 adds a way to name the server and takes nothing away.
    const resolved = new URL(
      resolveTestDatabaseUrl(
        { DATABASE_URL: BASE, PGPORT: "5433", PGHOST: "db.internal" },
        "/wt",
      ),
    );
    expect(resolved.port).toBe("5432");
    expect(resolved.hostname).toBe("localhost");
  });
});
