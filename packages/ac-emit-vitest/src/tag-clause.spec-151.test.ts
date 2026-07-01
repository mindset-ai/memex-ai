// spec-151 dec-1 (ac-5): the test-tagging primitive is generalised to a
// "verifiable subject" — a standard-CLAUSE ref rides the SAME shared emitter as
// an AC ref, with no parallel pipeline. `tagClause` forwards to `tagAc` (the
// single collection point feeding `emit()`), and a clause ref routes purely by
// its namespace prefix like any other ref (`deriveEventsUrl` has no AC-specific
// branch).
import { describe, it, expect } from "vitest";
import {
  tagAc,
  tagClause,
  _setCurrentTask,
  _readCurrentEntries,
} from "./index.js";
import { deriveEventsUrl } from "./derive-url.js";

const NS = "mindset-prod/memex-building-itself";
const CLAUSE_REF = `${NS}/standards/std-8/clauses/cl-1`;
const AC = `${NS}/specs/spec-151/acs`;

describe("tagClause: a clause ref is a first-class verifiable subject (spec-151 dec-1)", () => {
  it("routes a clause ref to the same destination an AC ref routes to, by namespace prefix, with no AC-specific branch [ac-5]", () => {
    tagAc(`${AC}/ac-5`);
    // One shared router: a clause ref and an AC ref in the same namespace
    // resolve to the identical destination. The router keys on the namespace
    // prefix alone — it never inspects the doc-type segment, so there is no
    // AC-vs-clause branch to drift.
    const clauseUrl = deriveEventsUrl(CLAUSE_REF);
    const acUrl = deriveEventsUrl(`${AC}/ac-5`);
    expect(clauseUrl).not.toBeNull();
    expect(clauseUrl).toBe(acUrl);
  });

  it("forwards to the SAME collection point as tagAc, carrying per-call metadata (no parallel pipeline)", () => {
    // Uses a fake task slot, so it does not self-tag (that would clobber the
    // real slot the setup hooks manage) — see task-slot.test.ts.
    const fakeTask = { meta: {} as Record<string, unknown> };
    try {
      _setCurrentTask(fakeTask);
      tagClause(CLAUSE_REF, { metadata: { clause_kind: "grep-denylist" } });
      const entries = _readCurrentEntries(fakeTask);
      // Stored shape is identical to a tagAc entry — the ref's grammar, not a
      // separate field, carries the subject type.
      expect(entries).toEqual([
        {
          ac_uid: CLAUSE_REF,
          options: { metadata: { clause_kind: "grep-denylist" } },
        },
      ]);
    } finally {
      _setCurrentTask(null);
    }
  });

  it("is a no-op outside a test body (no current-task slot)", () => {
    _setCurrentTask(null);
    expect(() => tagClause(CLAUSE_REF)).not.toThrow();
  });
});
