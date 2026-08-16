// spec-530 t-1 (dec-1) — the proposal body contract at clause grain.
//
// A proposal is an ordered SET of clause operations on one section, not a whole-section
// replacement. Each entry names its target by canonical handle [per std-10: the handle is
// the identifier, never an index], and edit/delete carry the target's body as read at
// authoring time — the "before" dec-3's staleness guard compares against.
//
// Pure unit test: the contract is string in / string out, so it needs no database.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  buildProposedChangeBody,
  parseProposedChangeBody,
  type ClauseOperation,
} from "./standards.js";

const AC_7 = "mindset-prod/memex-building-itself/specs/spec-530/acs/ac-7";

const MIXED: ClauseOperation[] = [
  { op: "edit", clause: "cl-12", before: "The old rule.", after: "The new rule." },
  { op: "add", anchor: "cl-12", placement: "after", body: "An example of the new rule." },
  { op: "delete", clause: "cl-40", before: "A rule that no longer applies." },
];

describe("spec-530 t-1: the clause-grained proposal body round-trips", () => {
  it("preserves every operation, in order, with its target handle (ac-7)", () => {
    tagAc(AC_7);
    const parsed = parseProposedChangeBody(
      buildProposedChangeBody("rule", MIXED, "because the rule drifted"),
    );

    expect(parsed?.kind).toBe("clause-ops");
    if (parsed?.kind !== "clause-ops") return;
    expect(parsed.operations).toEqual(MIXED);
  });

  it("keeps the rationale readable in the body (ac-7)", () => {
    tagAc(AC_7);
    const body = buildProposedChangeBody("rule", MIXED, "because the rule drifted");
    expect(body).toContain("because the rule drifted");
    // The section it targets is still named in the human-readable header.
    expect(body).toContain("rule");
  });

  it("resolves targets by handle, not by position — a reordered set is not a relabelled one (ac-7)", () => {
    tagAc(AC_7);
    const reversed = [...MIXED].reverse();
    const parsed = parseProposedChangeBody(buildProposedChangeBody("rule", reversed));

    expect(parsed?.kind).toBe("clause-ops");
    if (parsed?.kind !== "clause-ops") return;
    // Order is preserved as authored...
    expect(parsed.operations).toEqual(reversed);
    // ...and each operation still carries ITS OWN target, not the one that happens
    // to sit at that index in the original set. This is the assertion a
    // positional encoding fails.
    expect(parsed.operations[0]).toMatchObject({ op: "delete", clause: "cl-40" });
    expect(parsed.operations[2]).toMatchObject({ op: "edit", clause: "cl-12" });
  });

  it("round-trips bodies that would break a markdown fence (ac-7)", () => {
    tagAc(AC_7);
    // Clause bodies in a real Standard contain code blocks; the old contract picked
    // `~~~` precisely because ``` was common. With N bodies carried per proposal
    // (before AND after), a fence-delimited encoding eventually meets its own
    // delimiter — so the payload must survive both.
    const nasty = "```ts\nconst x = 1;\n```\n~~~\n~~~proposed-content\ntrailing";
    const ops: ClauseOperation[] = [
      { op: "edit", clause: "cl-1", before: nasty, after: `${nasty}\nplus more` },
    ];

    const parsed = parseProposedChangeBody(buildProposedChangeBody("rule", ops));
    expect(parsed?.kind).toBe("clause-ops");
    if (parsed?.kind !== "clause-ops") return;
    expect(parsed.operations[0]).toEqual(ops[0]);
  });

  it("preserves whitespace exactly — dec-3 compares the before byte-for-byte (ac-7)", () => {
    tagAc(AC_7);
    const ops: ClauseOperation[] = [
      { op: "delete", clause: "cl-9", before: "  leading and trailing spaces  \n\n" },
    ];
    const parsed = parseProposedChangeBody(buildProposedChangeBody("rule", ops));
    if (parsed?.kind !== "clause-ops") throw new Error("expected clause-ops");
    expect(parsed.operations[0]).toEqual(ops[0]);
  });

  it("reports a pre-cutover body as legacy instead of throwing (ac-7)", () => {
    tagAc(AC_7);
    // The shape proposeStandardChange wrote before this Spec: one whole-section
    // replacement in a `~~~proposed-content` fence. Stragglers exist (t-11 converts
    // them); a reader must degrade, never crash. t-9 carries this through the UI.
    const legacyBody = [
      "**Proposed change to section [rule]**",
      "",
      "(no rationale provided)",
      "",
      "~~~proposed-content",
      "The whole section, rewritten.",
      "~~~",
    ].join("\n");

    const parsed = parseProposedChangeBody(legacyBody);
    expect(parsed?.kind).toBe("legacy");
    if (parsed?.kind !== "legacy") return;
    expect(parsed.proposed).toBe("The whole section, rewritten.");
  });

  it("returns null for a body that is not a proposal at all (ac-7)", () => {
    tagAc(AC_7);
    expect(parseProposedChangeBody("Just a comment someone wrote.")).toBeNull();
  });
});
