import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db, memexContext, runWithMemexId } from "./connection.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-199 ac-13: AsyncLocalStorage per-request memex context.
// spec-199 ac-14: db Proxy injects set_config('app.memex_id') per query.
//
// ac-13 tests are pure unit tests (no DB): they exercise runWithMemexId and
// memexContext directly.
//
// ac-14 tests require a DB connection: they query current_setting() from
// inside a db.execute() call to verify the proxy actually set the GUC before
// the query ran. This is the only way to confirm at-the-wire correctness
// without mocking internals.

const AC_13 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-13";
const AC_14 = "mindset-prod/memex-building-itself/specs/spec-199/acs/ac-14";

// ── ac-13: AsyncLocalStorage ──────────────────────────────────────────────────

describe("spec-199 ac-13: AsyncLocalStorage per-request context", () => {
  it("ac-13: runWithMemexId makes memexId available via memexContext.getStore()", async () => {
    tagAc(AC_13);

    let captured: string | undefined;
    await runWithMemexId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", async () => {
      captured = memexContext.getStore()?.memexId;
    });

    expect(captured).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("ac-13: context is absent outside runWithMemexId", () => {
    tagAc(AC_13);
    expect(memexContext.getStore()).toBeUndefined();
  });

  it("ac-13: null memexId is a no-op — fn still runs, context stays unset", async () => {
    tagAc(AC_13);

    let insideContext: ReturnType<typeof memexContext.getStore>;
    await runWithMemexId(null, async () => {
      insideContext = memexContext.getStore();
    });

    expect(insideContext).toBeUndefined();
  });

  it("ac-13: undefined memexId is a no-op — fn still runs, context stays unset", async () => {
    tagAc(AC_13);

    let insideContext: ReturnType<typeof memexContext.getStore>;
    await runWithMemexId(undefined, async () => {
      insideContext = memexContext.getStore();
    });

    expect(insideContext).toBeUndefined();
  });

  it("ac-13: inner runWithMemexId overrides outer — no cross-tenant bleed", async () => {
    tagAc(AC_13);

    let outer: string | undefined;
    let inner: string | undefined;
    let afterInner: string | undefined;

    await runWithMemexId("outer-memex-id", async () => {
      outer = memexContext.getStore()?.memexId;
      await runWithMemexId("inner-memex-id", async () => {
        inner = memexContext.getStore()?.memexId;
      });
      afterInner = memexContext.getStore()?.memexId;
    });

    expect(outer).toBe("outer-memex-id");
    expect(inner).toBe("inner-memex-id");
    expect(afterInner).toBe("outer-memex-id");
  });

  it("ac-13: concurrent runWithMemexId calls are isolated from each other", async () => {
    tagAc(AC_13);

    const results: string[] = [];

    await Promise.all([
      runWithMemexId("memex-alpha", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(memexContext.getStore()?.memexId ?? "missing");
      }),
      runWithMemexId("memex-beta", async () => {
        await new Promise((r) => setTimeout(r, 5));
        results.push(memexContext.getStore()?.memexId ?? "missing");
      }),
    ]);

    expect(results).toContain("memex-alpha");
    expect(results).toContain("memex-beta");
    expect(results).not.toContain("missing");
  });
});

// ── ac-14: db Proxy GUC injection ─────────────────────────────────────────────

describe("spec-199 ac-14: db Proxy injects set_config per query", () => {
  it("ac-14: current_setting reflects memexId within a runWithMemexId scope", async () => {
    tagAc(AC_14);

    const testId = "12345678-1234-1234-1234-1234567890ab";
    let captured: string | null = null;

    await runWithMemexId(testId, async () => {
      // The proxy wraps this in: BEGIN / set_config('app.memex_id', testId, true)
      // / <query> / COMMIT. The query runs in the same txn and sees the GUC.
      const rows = await db.execute(
        sql`SELECT current_setting('app.memex_id', true) AS guc_value`,
      );
      captured =
        (rows as unknown as Array<{ guc_value: string | null }>)[0]?.guc_value ??
        null;
    });

    expect(captured).toBe(testId);
  });

  it("ac-14: GUC is absent (null) outside runWithMemexId — no ambient leakage", async () => {
    tagAc(AC_14);

    // No ALS context → proxy falls through to target.unsafe() → no set_config
    const rows = await db.execute(
      sql`SELECT current_setting('app.memex_id', true) AS guc_value`,
    );
    const value = (
      rows as unknown as Array<{ guc_value: string | null }>
    )[0]?.guc_value;

    // current_setting(..., true) returns NULL when the GUC has never been set
    // in this session. Accept NULL or empty string (postgres may normalise).
    expect(value == null || value === "").toBe(true);
  });

  it("ac-14: GUC does not leak between consecutive runWithMemexId calls", async () => {
    tagAc(AC_14);

    const testId = "abcdefab-cdef-abcd-efab-cdefabcdefab";

    // First call sets GUC inside the micro-transaction
    await runWithMemexId(testId, async () => {
      await db.execute(sql`SELECT 1`);
    });

    // After the scope exits, a plain query should see no GUC
    const rows = await db.execute(
      sql`SELECT current_setting('app.memex_id', true) AS guc_value`,
    );
    const value = (
      rows as unknown as Array<{ guc_value: string | null }>
    )[0]?.guc_value;

    expect(value == null || value === "").toBe(true);
  });

  it("ac-14: explicit db.transaction() inherits GUC via begin() intercept", async () => {
    tagAc(AC_14);

    const testId = "feedface-feed-face-feed-facefeedface";
    let captured: string | null = null;

    await runWithMemexId(testId, async () => {
      await db.transaction(async (tx) => {
        const rows = await tx.execute(
          sql`SELECT current_setting('app.memex_id', true) AS guc_value`,
        );
        captured =
          (rows as unknown as Array<{ guc_value: string | null }>)[0]
            ?.guc_value ?? null;
      });
    });

    expect(captured).toBe(testId);
  });
});
