// spec-440 ac-9: the tenant-context guard makes a context-less write to an
// RLS-gated table LOUD (warn + metric), phase 1 (no throw), catching raw
// db.insert/update/delete — not just mutate(). Pure unit test: exercises the
// guard's decision + emission directly, forcing the RLS-subject flag rather than
// relying on the async boot probe, so it is deterministic and DB-free.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  __resetRlsGuardForTests,
  __setRlsGuardThrowForTests,
  __setRlsSubjectRuntimeForTests,
  guardContextlessWrite,
  isContextlessGatedWrite,
  RlsContextViolationError,
  writeTargetTable,
} from "./rls-context-guard.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-440/acs/ac-9";
const AC_10 = "mindset-prod/memex-building-itself/specs/spec-440/acs/ac-10";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetRlsGuardForTests();
  // Silence the std-14 domain logger's console.log fan-out; assert on warn only.
  vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetRlsGuardForTests();
});

describe("spec-440 ac-9: writeTargetTable extracts the write target", () => {
  it("parses INSERT / UPDATE / DELETE, quoted + schema-qualified; reads → null", () => {
    tagAc(AC_9);

    expect(writeTargetTable('insert into "documents" ("id") values ($1)')).toBe("documents");
    expect(writeTargetTable("INSERT INTO documents DEFAULT VALUES")).toBe("documents");
    expect(writeTargetTable('update "presence" set "last_seen_at" = now()')).toBe("presence");
    expect(writeTargetTable('update only "tasks" set x = 1')).toBe("tasks");
    expect(writeTargetTable('delete from "acs" where "id" = $1')).toBe("acs");
    expect(writeTargetTable('insert into "public"."decisions" (a) values (1)')).toBe("decisions");
    expect(writeTargetTable('  \n  insert into "issues" (a) values (1)')).toBe("issues");

    // Reads and non-writes carry no write target.
    expect(writeTargetTable('select * from "documents"')).toBeNull();
    expect(writeTargetTable("SELECT 1")).toBeNull();
    expect(writeTargetTable("begin")).toBeNull();
  });
});

describe("spec-440 ac-9: isContextlessGatedWrite decision", () => {
  it("true only for a write to a gated table with no memexId in context", () => {
    tagAc(AC_9);

    // Gated write, no context → a violation.
    expect(isContextlessGatedWrite('insert into "documents" (a) values (1)', undefined)).toBe(true);
    expect(isContextlessGatedWrite('insert into "documents" (a) values (1)', {})).toBe(true);
    // userId-only context still lacks app.memex_id → a write still violates.
    expect(
      isContextlessGatedWrite('insert into "documents" (a) values (1)', {} as { memexId?: string }),
    ).toBe(true);

    // Tenant context present → RLS will pass, not a violation.
    expect(
      isContextlessGatedWrite('insert into "documents" (a) values (1)', { memexId: "m-1" }),
    ).toBe(false);

    // Non-gated table → never a violation (e.g. activity_log, usage_events).
    expect(isContextlessGatedWrite('insert into "activity_log" (a) values (1)', undefined)).toBe(
      false,
    );
    expect(isContextlessGatedWrite('insert into "usage_events" (a) values (1)', undefined)).toBe(
      false,
    );

    // Reads are never violations, even on a gated table with no context.
    expect(isContextlessGatedWrite('select * from "documents"', undefined)).toBe(false);
  });
});

describe("spec-440 ac-9: guardContextlessWrite emits LOUD, only when RLS-subject", () => {
  it("warns (once per table) on a context-less gated write when the runtime is RLS-subject", () => {
    tagAc(AC_9);
    __setRlsSubjectRuntimeForTests(true);

    guardContextlessWrite('insert into "documents" (a) values (1)', undefined);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[rls]");
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("documents");

    // Dedup: a second write to the same table warns no more (metric still counts).
    guardContextlessWrite('insert into "documents" (b) values (2)', undefined);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A different gated table warns once more.
    guardContextlessWrite('update "presence" set x = 1', undefined);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT warn when tenant context is present", () => {
    tagAc(AC_9);
    __setRlsSubjectRuntimeForTests(true);

    guardContextlessWrite('insert into "documents" (a) values (1)', { memexId: "m-1" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn on a context-less write to a NON-gated table", () => {
    tagAc(AC_9);
    __setRlsSubjectRuntimeForTests(true);

    guardContextlessWrite('insert into "activity_log" (a) values (1)', undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does NOT warn on a read, even of a gated table", () => {
    tagAc(AC_9);
    __setRlsSubjectRuntimeForTests(true);

    guardContextlessWrite('select * from "documents"', undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays SILENT when the runtime is NOT RLS-subject (owner connection)", () => {
    tagAc(AC_9);
    __setRlsSubjectRuntimeForTests(false);

    // The exact write that would warn under memex_app is a no-op under the owner
    // role (RLS bypassed), so the guard must not cry wolf in dev/test/migrations.
    guardContextlessWrite('insert into "documents" (a) values (1)', undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("spec-440 ac-10: guardContextlessWrite THROWS at the chokepoint when phase-2 is enabled", () => {
  it("throws a clear, table-named RlsContextViolationError on a context-less gated write", () => {
    tagAc(AC_10);
    __setRlsSubjectRuntimeForTests(true);
    __setRlsGuardThrowForTests(true);

    expect(() =>
      guardContextlessWrite('insert into "documents" (a) values (1)', undefined),
    ).toThrow(RlsContextViolationError);

    // The error names the offending table + the remedy — the point of throwing
    // early is a legible signal, not a swallowed `row-level security` DB rejection.
    try {
      guardContextlessWrite('update "tasks" set x = 1', undefined);
      expect.unreachable("guard should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RlsContextViolationError);
      expect((err as RlsContextViolationError).table).toBe("tasks");
      expect((err as Error).message).toContain("tasks");
      expect((err as Error).message).toContain("runWithMemexId");
    }
  });

  it("still WARNS (metric + log) BEFORE it throws — phase-1 observability holds in phase 2", () => {
    tagAc(AC_10);
    __setRlsSubjectRuntimeForTests(true);
    __setRlsGuardThrowForTests(true);

    expect(() =>
      guardContextlessWrite('insert into "documents" (a) values (1)', undefined),
    ).toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[rls]");
  });

  it("does NOT throw when phase-2 is off (the warn-only default)", () => {
    tagAc(AC_10);
    __setRlsSubjectRuntimeForTests(true);
    __setRlsGuardThrowForTests(false);

    expect(() =>
      guardContextlessWrite('insert into "documents" (a) values (1)', undefined),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT throw for a context-present write, a read, or a non-gated table — even with phase-2 on", () => {
    tagAc(AC_10);
    __setRlsSubjectRuntimeForTests(true);
    __setRlsGuardThrowForTests(true);

    expect(() =>
      guardContextlessWrite('insert into "documents" (a) values (1)', { memexId: "m-1" }),
    ).not.toThrow();
    expect(() => guardContextlessWrite('select * from "documents"', undefined)).not.toThrow();
    expect(() =>
      guardContextlessWrite('insert into "activity_log" (a) values (1)', undefined),
    ).not.toThrow();
  });

  it("stays SILENT (no throw, no warn) under the owner role even with phase-2 on", () => {
    tagAc(AC_10);
    __setRlsSubjectRuntimeForTests(false);
    __setRlsGuardThrowForTests(true);

    // The whole guard — warn AND throw — is gated on the runtime being RLS-subject,
    // so dev / owner suites / migrations are never affected.
    expect(() =>
      guardContextlessWrite('insert into "documents" (a) values (1)', undefined),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("spec-440 ac-10: phase-2 is enabled by MEMEX_RLS_GUARD_THROW (the prod/int enablement path)", () => {
  // With NO test-hook override the guard defers to the env, read LIVE on the rare
  // violation path — this is exactly how int + prod enable it (deploy.sh sets the var).
  const prev = process.env.MEMEX_RLS_GUARD_THROW;
  afterEach(() => {
    if (prev === undefined) delete process.env.MEMEX_RLS_GUARD_THROW;
    else process.env.MEMEX_RLS_GUARD_THROW = prev;
  });

  it("throws when MEMEX_RLS_GUARD_THROW=1 and no hook override is set", () => {
    tagAc(AC_10);
    __setRlsSubjectRuntimeForTests(true);
    process.env.MEMEX_RLS_GUARD_THROW = "1";

    expect(() =>
      guardContextlessWrite('insert into "documents" (a) values (1)', undefined),
    ).toThrow(RlsContextViolationError);
  });

  it("stays warn-only for unset / off-values (0, false, off, no)", () => {
    tagAc(AC_10);
    for (const val of ["", "0", "false", "off", "no"]) {
      __resetRlsGuardForTests(); // clears the hook override + warn dedup
      __setRlsSubjectRuntimeForTests(true);
      if (val === "") delete process.env.MEMEX_RLS_GUARD_THROW;
      else process.env.MEMEX_RLS_GUARD_THROW = val;

      expect(
        () => guardContextlessWrite('insert into "documents" (a) values (1)', undefined),
        `value "${val}" must not enable the throw`,
      ).not.toThrow();
    }
  });
});
