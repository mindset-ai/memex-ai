// spec-520 t-4 (ac-7 / ac-11) — no hot-path read binds one parameter per AC ref.
//
// ⚠ THIS IS A SOURCE SCAN, and it is worth saying so rather than dressing it as behavioural.
// The claim is about the SHAPE of the generated SQL, and the honest behavioural test would
// compare pg_stat_statements queryids across two runs with different ref counts — identical
// under the fix, different before it. pg_stat_statements is not loaded on the local cluster
// (it needs shared_preload_libraries and a restart), so that test cannot run here. What CAN
// be pinned locally is that the offending construct does not come back, which is the
// regression that actually threatens this fix. Correctness is covered separately and
// behaviourally by ac-health-parity.spec-520.test.ts.
//
// THE COST BEING PREVENTED. `inArray(testEventLatest.subjectRef, refs)` emits
// `subject_ref IN ($1, $2, … $n)`. Each distinct n is its own prepared statement, plan-cache
// entry and pg_stat_statements row. Measured on prod: 1,098 fingerprints on 2026-08-18 and
// 1,223 on 2026-08-28 — ~12/day, ~24.5% of the instance's 5,000-entry cap, which is 98.6%
// full and already evicting (issue-10). Planning time for the 1,800-literal form was 7.564 ms
// against 0.037 ms for the simple one.
//
// The two replacements are deliberately DIFFERENT, and neither is a stylistic preference:
//   • aggregateAcHealthForBriefs -> `memex_id = $1`. It already read every row of the tenant
//     (the seq scan touches them all), so scoping tenant-wide costs nothing and makes
//     tenancy an explicit predicate instead of an inference from ref-string uniqueness.
//   • listAcsForBriefWithVerification and the clause-coverage read -> `= ANY($1::text[])`.
//     These serve ONE Spec / one standard, so a tenant-wide read would fetch ~148k rows for
//     the largest Memex to filter down to a handful. ANY is one parameter regardless of ref
//     count, which removes the fragmentation without the over-fetch.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const AC_SCOPED = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-7";
const AC_NO_WIDE_IN = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-11";

const src = (rel: string) =>
  readFileSync(resolve(import.meta.dirname, "..", rel), "utf8");

describe("spec-520 ac-7 / ac-11: no read binds one parameter per AC ref", () => {
  it("no hot-path read passes a ref ARRAY to inArray against test_event_latest.subject_ref", () => {
    tagAc(AC_NO_WIDE_IN);
    // Located by construct, not by line — this Spec's line references have drifted between
    // grounding passes, and the task says so explicitly.
    const offenders: string[] = [];
    for (const rel of ["services/acs.ts", "services/clause-coverage.ts"]) {
      const text = src(rel);
      if (/inArray\(\s*testEventLatest\.subjectRef/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("aggregateAcHealthForBriefs scopes the summary read on memex_id", () => {
    tagAc(AC_SCOPED);
    const text = src("services/acs.ts");
    // The whole function, isolated so a match elsewhere in this large file cannot pass it.
    const start = text.indexOf("export async function aggregateAcHealthForBriefs");
    expect(start).toBeGreaterThan(-1);
    const body = text.slice(start, start + 6000);
    expect(body).toMatch(/eq\(testEventLatest\.memexId, memexId\)/);
  });

  it("the single-Spec reads bind the ref list as ONE array parameter", () => {
    tagAc(AC_NO_WIDE_IN);
    for (const rel of ["services/acs.ts", "services/clause-coverage.ts"]) {
      const text = src(rel);
      // sql.param() is the load-bearing half: a bare `${refs}` makes drizzle interpolate the
      // array as a LIST of parameters — the very fragmentation being removed — and fails
      // against `= ANY(…)` outright. That is not hypothetical; it happened while building
      // this, and the query errored with the array flattened into separate params.
      expect(text).toMatch(/ANY\(\$\{sql\.param\(allRefs\)\}::text\[\]\)/);
    }
  });

  it("both single-Spec reads also carry an explicit memex_id predicate", () => {
    tagAc(AC_SCOPED);
    // Tenancy stops being an inference from ref-string uniqueness (the spec-396 posture),
    // and it is what makes the (memex_id, subject_ref) index usable for these reads at all.
    for (const rel of ["services/acs.ts", "services/clause-coverage.ts"]) {
      expect(src(rel)).toMatch(/eq\(testEventLatest\.memexId, memexId\)/);
    }
  });
});
