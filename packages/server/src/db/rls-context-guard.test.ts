// spec-440 ac-9: the tenant-context guard makes a context-less write to an
// RLS-gated table LOUD (warn + metric), phase 1 (no throw), catching raw
// db.insert/update/delete — not just mutate(). Pure unit test: exercises the
// guard's decision + emission directly, forcing the RLS-subject flag rather than
// relying on the async boot probe, so it is deterministic and DB-free.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  __resetRlsGuardForTests,
  __setRlsSubjectRuntimeForTests,
  guardContextlessWrite,
  isContextlessGatedWrite,
  writeTargetTable,
} from "./rls-context-guard.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-440/acs/ac-9";

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
