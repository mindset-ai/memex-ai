// b-97 unit tests for the decision lifecycle tool surface.
//
// These are pure structural assertions: they import the `toolSpecs` registry,
// the source code as text, and the zod schemas, and check the b-97 contracts
// without touching Postgres. CI runs them; cold `pnpm test` runs them. They
// re-verify ac-5 / ac-6 / ac-7 on every invocation.
//
// What lives here:
//   - ac-5: no hard-delete code path on the decisions table.
//   - ac-6: `delete_decision` uses the same auth gate as the existing decision
//     verbs (no extra middleware, no extra capability check at the spec level).
//   - ac-7: no `restore_decision` tool registered; `update_decision`'s status
//     schema accepts the four restorable statuses but NOT `deleted`.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { ZodTypeAny } from "zod";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolSpecs } from "./tool-specs.js";

const SERVICES_DIR = join(__dirname, "..", "services");

describe("b-97 ac-5 — no hard-delete code path for decisions", () => {
  it("no production service file calls db.delete(decisions) on the decisions table", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-5");

    // Walk services/ for .ts files that are NOT tests and NOT test helpers.
    // Each is scanned as plain text for the forbidden pattern. b-97 dec-2
    // pivoted from hard-delete to soft-delete via status='deleted', so this
    // assertion is the structural guard against the original design coming
    // back in via a future PR.
    const entries = readdirSync(SERVICES_DIR, { withFileTypes: true });
    const productionTsFiles = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter(
        (name) =>
          name.endsWith(".ts") &&
          !name.endsWith(".test.ts") &&
          !name.endsWith(".integration.test.ts") &&
          name !== "test-helpers.ts",
      );

    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of productionTsFiles) {
      const path = join(SERVICES_DIR, file);
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, idx) => {
        // Match `db.delete(decisions)` and the transaction variant
        // `tx.delete(decisions)`. Whitespace tolerant; case sensitive
        // because Drizzle's API is camelCase.
        if (/\b(?:db|tx)\s*\.\s*delete\s*\(\s*decisions\b/.test(line)) {
          offenders.push({ file, line: idx + 1, text: line.trim() });
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});

describe("b-97 ac-6 — delete_decision uses the same auth gate as existing decision verbs", () => {
  it("delete_decision is registered with no extra middleware/auth flags at the spec level", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-6");

    // ac-6 says: the auth bar for delete + restore must be the same as the
    // rest of the decision verbs (any active member, gated by the existing
    // memexId scoping). At the ToolSpec level, that means delete_decision has
    // the same shape as resolve_decision / update_decision: no extra fields,
    // no opt-in capability flag, just `ref` + `verbose`. Any deviation here
    // would imply a route-level or middleware-level gate is being added —
    // which would break the dec-3 commitment.
    const del = toolSpecs.find((s) => s.name === "delete_decision");
    const update = toolSpecs.find((s) => s.name === "update_decision");
    const resolve = toolSpecs.find((s) => s.name === "resolve_decision");

    expect(del).toBeDefined();
    expect(update).toBeDefined();
    expect(resolve).toBeDefined();

    // The annotations shape is the per-tool auth surface. Compare flags
    // structurally — readOnlyHint must be false for all three (they all
    // mutate), destructiveHint differs (delete is destructive, the others
    // aren't). No `requiresOwner` / `requiresAdmin` flag exists on any of
    // them; if one did, it'd show up here and the assertion would fail.
    const delKeys = Object.keys(del!.annotations).sort();
    const updateKeys = Object.keys(update!.annotations).sort();
    expect(delKeys).toEqual(updateKeys);
  });

  it("delete_decision schema is the minimal { ref, verbose } shape — no extra auth fields", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-6");
    const del = toolSpecs.find((s) => s.name === "delete_decision");
    expect(del).toBeDefined();
    const fieldNames = Object.keys(del!.schema).sort();
    expect(fieldNames).toEqual(["ref", "verbose"]);
  });
});

describe("b-97 ac-7 — restore is via update_decision, not a dedicated restore_decision tool", () => {
  it("no restore_decision tool is registered", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-7");
    const restoreTool = toolSpecs.find((s) => s.name === "restore_decision");
    expect(restoreTool).toBeUndefined();
  });

  it("update_decision schema accepts the four restorable statuses", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-7");
    const update = toolSpecs.find((s) => s.name === "update_decision");
    expect(update).toBeDefined();
    // ZodRawShape erases the value-type at the index signature; cast to the
    // generic ZodTypeAny so .parse() type-checks. The schema is a plain zod
    // enum at runtime, so each .parse call exercises the actual narrowing.
    const statusSchema = update!.schema.status as unknown as ZodTypeAny;
    expect(() => statusSchema.parse("open")).not.toThrow();
    expect(() => statusSchema.parse("resolved")).not.toThrow();
    expect(() => statusSchema.parse("candidate")).not.toThrow();
    expect(() => statusSchema.parse("rejected")).not.toThrow();
  });

  it("update_decision schema rejects status='deleted' (delete is delete_decision's job)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-97/acs/ac-7");
    const update = toolSpecs.find((s) => s.name === "update_decision");
    expect(update).toBeDefined();
    const statusSchema = update!.schema.status as unknown as ZodTypeAny;
    expect(() => statusSchema.parse("deleted")).toThrow();
  });
});
