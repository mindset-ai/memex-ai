// spec-533 t-4 (ac-17) — the MCP tier stayed deferred.
//
// dec-6 chose the response header and DECLINED MCP's price: a transport or route
// column on the hottest table, or a rollup, plus a retention policy for it, all
// under std-39. That refusal needs a lock, because it is exactly the kind of cost
// that arrives later by accident — someone adds `transport` to test_events "while
// they're in there", and the decision is undone without anyone deciding.
//
// The shape is spec-358's: that Spec froze a column and pinned the freeze with a
// scan over drizzle/*.sql, because a promise about migrations that nothing checks
// is a promise about migrations that will be broken.
//
// dec-4 names the ONE outcome that would justify paying: a flat emissions-per-
// request ratio whose cause is unreachability rather than sampling or copy. Until
// then this guard should be red-on-purpose if anyone reaches for the column.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_17 = "mindset-prod/memex-building-itself/specs/spec-533/acs/ac-17";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "drizzle");
const SCHEMA = join(__dirname, "..", "db", "schema.ts");

function migrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf-8") }));
}

/** The words someone would reach for if they added the column dec-6 declined. */
const TRANSPORT_ISH = /\b(transport|route|endpoint|is_batch|batched|via)\b/i;

describe("spec-533 t-4: no transport column, no ingest rollup [ac-17]", () => {
  it("test_events carries no transport / route column in the schema", () => {
    tagAc(AC_17);
    const src = readFileSync(SCHEMA, "utf-8");
    const start = src.indexOf("export const testEvents = pgTable");
    expect(start).toBeGreaterThan(-1); // the table still exists under this name
    // Bound the slice to the table literal so a match cannot come from a
    // neighbouring table's columns.
    const table = src.slice(start, src.indexOf("\n);", start));

    const columns = [...table.matchAll(/^\s{4}(\w+):\s*(?:text|uuid|integer|jsonb|timestamp|boolean)\(/gm)]
      .map((m) => m[1]);
    // The set dec-6's reasoning rests on. If this list grows a transport-shaped
    // member, the MCP tier stopped being deferred.
    expect(columns).toEqual([
      "id",
      "subjectRef",
      "memexId",
      "status",
      "testIdentifier",
      "durationMs",
      "commitSha",
      "runId",
      "actor",
      "hidden",
      "metadata",
      "createdAt",
    ]);
    for (const col of columns) {
      expect(col).not.toMatch(TRANSPORT_ISH);
    }
  });

  it("no migration adds a transport / route column to test_events", () => {
    tagAc(AC_17);
    const offenders: string[] = [];
    for (const { file, sql } of migrations()) {
      for (const line of sql.split("\n")) {
        // Only ALTER … ADD COLUMN on this table can widen it.
        if (!/alter\s+table[^;]*test_events/i.test(line)) continue;
        if (!/add\s+column/i.test(line)) continue;
        if (TRANSPORT_ISH.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no migration creates an ingest-shape rollup table", () => {
    tagAc(AC_17);
    // The other half of MCP's price: a per-Memex aggregate the server could read
    // OUTSIDE the request that carried the fact. The header needs none, because
    // it answers during the request.
    const offenders: string[] = [];
    for (const { file, sql } of migrations()) {
      for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)) {
        const table = m[1] ?? "";
        if (/(emission|ingest|test_event).*(stat|rollup|summary|count|shape|ratio)/i.test(table)) {
          // test_event_latest predates this Spec and is a per-AC verdict cache,
          // not an ingest-shape rollup — named so the guard stays honest.
          if (table === "test_event_latest") continue;
          offenders.push(`${file}: ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("spec-533 t-4: no MCP surface carries the advisory [ac-17]", () => {
  it("no tool description or manifest summary mentions un-batched consumers or a version range", () => {
    tagAc(AC_17);
    // dec-6 deferred the agent-facing nudge, and dec-4 recorded WHY the register
    // would matter if it ever ships: a tool response must read as context, never
    // as an instruction to abandon the user's task and chase a dependency bump.
    // Until that decision is revisited, nothing on the MCP surface says it.
    const sources = [
      join(__dirname, "..", "agent", "handlers", "acs.ts"),
      join(__dirname, "..", "agent", "tool-specs.ts"),
      join(__dirname, "..", "..", "..", "shared", "src", "tool-manifest.ts"),
    ].map((p) => ({ p, src: readFileSync(p, "utf-8") }));

    for (const { p, src } of sources) {
      expect(src, `${p} must not carry the staleness advisory`).not.toMatch(/Un-batched/);
      expect(src, `${p} must not name a target version range`).not.toMatch(
        /\^0\.\d+\.\d+/,
      );
      expect(src, `${p} must not describe un-batched consumers`).not.toMatch(
        /un-batched consumer/i,
      );
    }
  });
});
