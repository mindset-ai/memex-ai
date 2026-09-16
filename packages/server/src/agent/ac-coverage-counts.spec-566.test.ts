// spec-566 t-5 — the coverage headline an agent reads counts the LIVE set and
// names the superseded ones beside it.
//
//   ac-13  the live percentage excludes superseded criteria from both numerator
//          and denominator, so 10 verified of 11 with one superseded reports
//          100% with a superseded count of 1 — never 91%, never a bare 100%
//
// Pure over the rows the helper is handed (no DB, no clock), like the spec-207
// tripwire it sits beside.
//
// TWO POPULATIONS, ONE RULE. Before this Spec, `formatAcCoverageSummary` was
// handed an active-only set by `formatCoverageHeader` (the get_doc path) and
// the UNFILTERED set by the `list_acs` handler. The same Spec therefore had two
// coverage sentences depending on which tool you called. Adding a count inside
// the helper without settling that would have shipped the divergence, so the
// helper is now the sole authority on population: it filters to `active`
// itself. `proposed` / `rejected` rows leave the denominator with no count of
// their own — that is exactly what the get_doc path already did, so this
// unifies the two rather than inventing a third behaviour.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { formatAcCoverageSummary } from "./tool-specs.js";
import type { AcWithVerification, VerificationState } from "../services/acs.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-566";
const acRef = (n: number) => `${SPEC}/acs/ac-${n}`;

function makeAc(
  seq: number,
  state: VerificationState,
  status: "active" | "superseded" | "proposed" | "rejected" = "active",
): AcWithVerification {
  return {
    ac: {
      seq,
      kind: "implementation",
      statement: `claim ${seq}`,
      status,
    } as unknown as AcWithVerification["ac"],
    canonicalRef: acRef(seq),
    tests:
      state === "untested"
        ? []
        : ([
            { testIdentifier: `t-${seq}`, latestStatus: "pass", runCount: 1 },
          ] as unknown as AcWithVerification["tests"]),
    verificationState: state,
    supersessionProposed: false,
    daysSinceLastRun: state === "untested" ? null : 1,
    parents: [],
  };
}

describe("spec-566 ac-13 — the live percentage, and the count beside it", () => {
  // The Spec's own worked example. Both readings of 100% have to hold at once:
  // `covered` keys off `tests.length > 0` while `verified` is a verification
  // state, so the ten live criteria carry a passing test EACH — otherwise this
  // could read 100% for the wrong reason.
  it("reports 10 of 10 at 100% with 1 superseded — never 91%, never a bare 100%", () => {
    tagAc(acRef(13));

    const rows = [
      ...Array.from({ length: 10 }, (_, i) => makeAc(i + 1, "verified")),
      makeAc(11, "verified", "superseded"),
    ];

    const out = formatAcCoverageSummary(rows);

    expect(out).toBe(
      "0 of 10 ACs not verified · 100% covered (of 10) · 1 superseded",
    );
    // Stated separately from the equality above so a future reword of the
    // sentence cannot quietly reintroduce either failure mode.
    expect(out).not.toContain("91%");
    expect(out).not.toContain("of 11");
  });

  it("keeps the superseded criterion out of the NOT VERIFIED lead", () => {
    tagAc(acRef(13));

    // Vacuity guard: an untested superseded row is the only thing that could
    // put ac-11 in the gap list, so it must genuinely be untested.
    const superseded = makeAc(11, "untested", "superseded");
    expect(superseded.tests).toEqual([]);

    const out = formatAcCoverageSummary([makeAc(1, "verified"), superseded]);

    expect(out).toBe("0 of 1 AC not verified · 100% covered (of 1) · 1 superseded");
    expect(out).not.toContain("ac-11");
  });

  it("says nothing when nothing is superseded", () => {
    tagAc(acRef(13));

    const out = formatAcCoverageSummary([makeAc(1, "verified"), makeAc(2, "untested")]);

    expect(out).not.toContain("superseded");
    expect(out).toBe("1 of 2 ACs NOT VERIFIED: ac-2 · 50% covered (of 2)");
  });

  it("counts every superseded criterion, and still reads when ALL of them are", () => {
    tagAc(acRef(13));

    const out = formatAcCoverageSummary([
      makeAc(1, "verified", "superseded"),
      makeAc(2, "verified", "superseded"),
      makeAc(3, "verified", "superseded"),
    ]);

    // 0/0 is honest here: nothing live is committed. The count is the whole
    // signal, and a bare "0 of 0 ACs not verified · 0% covered (of 0)" would
    // read as a Spec that never wrote a criterion.
    expect(out).toContain("3 superseded");
    expect(out).toBe("0 of 0 ACs not verified · 0% covered (of 0) · 3 superseded");
  });

  // The filter case, and the reason `supersededTotal` exists.
  //
  // `list_acs({ status: 'active' })` is the query an agent runs to ask "is this
  // Spec done?". That filter hands the helper no superseded rows at all, so a
  // count derived from the rows it can see is zero and the retirement becomes
  // invisible to the one query that most needs it — a clean 100%, no trace. The
  // handler counts over the UNFILTERED set and passes the total in.
  it("reports the retirement even when the caller filtered it out of the rows", () => {
    tagAc(acRef(13));

    const activeOnly = Array.from({ length: 10 }, (_, i) => makeAc(i + 1, "verified"));

    // Vacuity guard: with no override this reads as a clean 100% and says
    // nothing — which is exactly the sentence the override exists to prevent.
    expect(formatAcCoverageSummary(activeOnly)).not.toContain("superseded");

    const out = formatAcCoverageSummary(activeOnly, { supersededTotal: 1 });
    expect(out).toBe("0 of 10 ACs not verified · 100% covered (of 10) · 1 superseded");
  });

  it("excludes proposed and rejected criteria from the denominator, uncounted", () => {
    tagAc(acRef(13));

    const out = formatAcCoverageSummary([
      makeAc(1, "verified"),
      makeAc(2, "untested", "proposed"),
      makeAc(3, "untested", "rejected"),
    ]);

    // The get_doc header already filtered these out; this is the list_acs path
    // catching up, not a new rule. Only supersession gets a count (dec-2).
    expect(out).toBe("0 of 1 AC not verified · 100% covered (of 1)");
  });
});
