import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  docSections,
  docComments,
  decisions,
  tasks,
  acs,
  activityLog,
  presence,
  commsLog,
} from "./schema.js";

// spec-378 (parent spec-355 dry-3, audit spec-345) — the activity contract's
// `channel` / `actor_kind` CHECK vocabularies (std-32) were hand-written across
// 9 sites in schema.ts. They were hoisted to two named SQL-fragment helpers
// (activityChannelCheck / activityActorKindCheck) that interpolate each table's
// own column. This guard pins the EMITTED CHECK SQL byte-for-byte, so a future
// edit to a helper (or an accidental drift of an allowed value) is caught: the
// allowed values are load-bearing (std-32), and the refactor must be SQL-identical.

const AC = "mindset-prod/memex-building-itself/specs/spec-378/acs/ac-5";
// Scope ACs this guard empirically verifies (outcome commitments):
const AC_CHANNEL_SINGLE_SOURCE = "mindset-prod/memex-building-itself/specs/spec-378/acs/ac-1";
const AC_ACTOR_KIND_SINGLE_SOURCE = "mindset-prod/memex-building-itself/specs/spec-378/acs/ac-2";
const AC_BYTE_IDENTICAL = "mindset-prod/memex-building-itself/specs/spec-378/acs/ac-3";
const AC_COMMS_LOG_UNTOUCHED = "mindset-prod/memex-building-itself/specs/spec-378/acs/ac-4";

const dialect = new PgDialect();

// The pre-refactor literal SQL for each CHECK — proven byte-identical to HEAD by
// emitting both via getTableConfig + sqlToQuery and diffing (dec-1 resolution).
const CHANNEL_LIST = "IN ('rest_ui', 'mcp', 'in_app_agent', 'server')";
const ACTOR_KIND_LIST = "IN ('human', 'mcp_agent', 'in_app_agent', 'system')";

// table object → fully-qualified column reference drizzle emits in the CHECK.
const CHANNEL_TABLES: Array<[string, ReturnType<typeof getTableConfig>, string]> = [
  ["doc_sections", getTableConfig(docSections), `"doc_sections"."channel" ${CHANNEL_LIST}`],
  ["doc_comments", getTableConfig(docComments), `"doc_comments"."channel" ${CHANNEL_LIST}`],
  ["decisions", getTableConfig(decisions), `"decisions"."channel" ${CHANNEL_LIST}`],
  ["tasks", getTableConfig(tasks), `"tasks"."channel" ${CHANNEL_LIST}`],
  ["acs", getTableConfig(acs), `"acs"."channel" ${CHANNEL_LIST}`],
  ["activity_log", getTableConfig(activityLog), `"activity_log"."channel" ${CHANNEL_LIST}`],
  ["presence", getTableConfig(presence), `"presence"."channel" ${CHANNEL_LIST}`],
];

const ACTOR_KIND_TABLES: Array<[string, ReturnType<typeof getTableConfig>, string]> = [
  ["activity_log", getTableConfig(activityLog), `"activity_log"."actor_kind" ${ACTOR_KIND_LIST}`],
  ["presence", getTableConfig(presence), `"presence"."actor_kind" ${ACTOR_KIND_LIST}`],
];

function checkSqlByName(cfg: ReturnType<typeof getTableConfig>, name: string): string {
  const check = cfg.checks.find((c) => c.name === name);
  if (!check) throw new Error(`CHECK '${name}' not found on table`);
  return dialect.sqlToQuery(check.value).sql;
}

describe("spec-378: activity-contract CHECK vocab is hoisted, SQL byte-identical (ac-5)", () => {
  it("ac-5: all 7 channel CHECKs emit the canonical activity-channel vocabulary verbatim", () => {
    tagAc(AC);
    for (const [table, cfg, expected] of CHANNEL_TABLES) {
      const constraintName = `${table}_channel_valid`;
      const got = checkSqlByName(cfg, constraintName);
      expect(got, `${constraintName} CHECK SQL drifted`).toBe(expected);
    }
  });

  it("ac-5: both actor_kind CHECKs emit the canonical actor-kind vocabulary verbatim", () => {
    tagAc(AC);
    for (const [table, cfg, expected] of ACTOR_KIND_TABLES) {
      const constraintName = `${table}_actor_kind_valid`;
      const got = checkSqlByName(cfg, constraintName);
      expect(got, `${constraintName} CHECK SQL drifted`).toBe(expected);
    }
  });

  it("ac-4 / ac-5: comms_log.channel keeps its DISTINCT notification vocabulary (not collapsed onto the activity helper)", () => {
    tagAc(AC);
    tagAc(AC_COMMS_LOG_UNTOUCHED);
    const got = checkSqlByName(getTableConfig(commsLog), "comms_log_channel_valid");
    expect(got).toBe(`"comms_log"."channel" IN ('email', 'in_app', 'badge', 'os')`);
    // And it must NOT have been rewritten to the activity-channel list.
    expect(got).not.toContain("rest_ui");
  });
});

// Source-level single-source guard: the load-bearing value-list literal for each
// activity vocabulary must appear EXACTLY ONCE in schema.ts — inside its helper.
// That is what "defined in exactly one place" (ac-1 / ac-2) means concretely.
const SCHEMA_SRC = readFileSync(
  fileURLToPath(new URL("./schema.ts", import.meta.url)),
  "utf8",
);

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("spec-378: each activity vocabulary literal is defined in exactly one place (ac-1, ac-2)", () => {
  it("ac-1: the channel value-list literal appears exactly once in schema.ts (the helper)", () => {
    tagAc(AC_CHANNEL_SINGLE_SOURCE);
    expect(
      countOccurrences(SCHEMA_SRC, "IN ('rest_ui', 'mcp', 'in_app_agent', 'server')"),
      "activity-channel vocabulary should be hoisted to a single helper",
    ).toBe(1);
  });

  it("ac-2: the actor_kind value-list literal appears exactly once in schema.ts (the helper)", () => {
    tagAc(AC_ACTOR_KIND_SINGLE_SOURCE);
    expect(
      countOccurrences(SCHEMA_SRC, "IN ('human', 'mcp_agent', 'in_app_agent', 'system')"),
      "actor_kind vocabulary should be hoisted to a single helper",
    ).toBe(1);
  });

  it("ac-3: byte-identity is asserted (cross-tags the dedicated emitted-SQL checks above)", () => {
    tagAc(AC_BYTE_IDENTICAL);
    // The emitted-SQL assertions in the first describe block prove byte-identity;
    // this case ties that empirical proof to the byte-identity scope AC explicitly.
    for (const [, cfg, expected] of [...CHANNEL_TABLES, ...ACTOR_KIND_TABLES]) {
      const name = cfg.checks.find((c) => dialect.sqlToQuery(c.value).sql === expected)?.name;
      expect(name, `expected a CHECK emitting exactly: ${expected}`).toBeTruthy();
    }
  });
});
