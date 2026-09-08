// spec-552 t-2 (dec-8) — the rollout gate's decision function.
//
// The property that matters is the NEGATIVE one: everything that is not an
// explicit match resolves to CLOSED. A gate whose misconfigured state is "open"
// would make a forgotten variable the most exposed deploy, so the table below
// leads with the ways a value can be absent or wrong.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { costPanelAllowlist, costPanelEnabledFor } from "./cost-panel-flag.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;

const VAR = "COST_PANEL_MEMEXES";

// Restore the ambient value rather than deleting it, so a run with the flag set
// in the environment cannot leak into (or be broken by) these tests [per std-37].
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[VAR];
});

afterEach(() => {
  if (saved === undefined) delete process.env[VAR];
  else process.env[VAR] = saved;
});

function withValue(value: string | undefined): void {
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
}

describe("costPanelEnabledFor — default closed", () => {
  const closedCases: Array<[label: string, value: string | undefined]> = [
    ["unset", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["a lone comma", ","],
    ["commas and spaces only", " , ,  "],
  ];

  for (const [label, value] of closedCases) {
    it(`admits nobody when the value is ${label}`, () => {
      tagAc(AC(17));
      withValue(value);
      expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
        false
      );
      expect(costPanelAllowlist()).toEqual([]);
    });
  }

  it("admits nobody for a value that names no Memex we can match", () => {
    tagAc(AC(17));
    // Not a ref, not the wildcard — a typo, in other words. It must not open
    // the gate for anyone, and must not throw either.
    withValue("true");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      false
    );
  });

  it("refuses a blank identity even when the allowlist is populated", () => {
    tagAc(AC(17));
    // Guards the shape where an unresolved request compares "/" against the
    // list: a stray "/" entry must not become a master key.
    withValue("/");
    expect(costPanelEnabledFor("", "")).toBe(false);
    expect(costPanelEnabledFor("mindset-prod", "")).toBe(false);
    expect(costPanelEnabledFor("", "memex-building-itself")).toBe(false);
  });
});

describe("costPanelEnabledFor — the allowlist", () => {
  it("admits a listed Memex and refuses an unlisted one", () => {
    tagAc(AC(18));
    withValue("mindset-prod/memex-building-itself");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      true
    );
    expect(costPanelEnabledFor("mindset-prod", "some-other-memex")).toBe(false);
    // Same memex slug under a different namespace is a DIFFERENT Memex.
    expect(costPanelEnabledFor("other-ns", "memex-building-itself")).toBe(false);
  });

  it("admits every entry in a multi-entry list, tolerating stray whitespace", () => {
    tagAc(AC(18));
    withValue("  first-ns/one ,second-ns/two,  third-ns/three  ");
    expect(costPanelEnabledFor("first-ns", "one")).toBe(true);
    expect(costPanelEnabledFor("second-ns", "two")).toBe(true);
    expect(costPanelEnabledFor("third-ns", "three")).toBe(true);
    expect(costPanelEnabledFor("fourth-ns", "four")).toBe(false);
    expect(costPanelAllowlist()).toEqual([
      "first-ns/one",
      "second-ns/two",
      "third-ns/three",
    ]);
  });

  it("matches case-insensitively on both halves", () => {
    tagAc(AC(18));
    withValue("Mindset-Prod/Memex-Building-Itself");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      true
    );
    expect(costPanelEnabledFor("MINDSET-PROD", "MEMEX-BUILDING-ITSELF")).toBe(
      true
    );
  });

  it("does not match on a prefix — a doc ref must never satisfy the gate", () => {
    tagAc(AC(18));
    // The two-argument signature is what makes this structurally impossible,
    // and this asserts the shape rather than trusting it: a memex slug that
    // happens to carry further path segments is not the listed Memex.
    withValue("mindset-prod/memex-building-itself");
    expect(
      costPanelEnabledFor("mindset-prod", "memex-building-itself/specs/spec-1")
    ).toBe(false);
  });

  it("opens the panel to every Memex on the wildcard — including one not named anywhere", () => {
    tagAc(AC(18));
    withValue("*");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      true
    );
    // A Memex created after the value was set is admitted by construction:
    // nothing in the value enumerates it.
    expect(costPanelEnabledFor("a-brand-new-namespace", "created-later")).toBe(
      true
    );
  });

  it("honours the wildcard when it sits alongside explicit entries", () => {
    tagAc(AC(18));
    withValue("mindset-prod/memex-building-itself, *");
    expect(costPanelEnabledFor("someone-else", "their-memex")).toBe(true);
  });

  it("is read LIVE — flipping the value changes the next call, with no restart", () => {
    tagAc(AC(18));
    withValue("");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      false
    );
    withValue("mindset-prod/memex-building-itself");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      true
    );
    withValue("");
    expect(costPanelEnabledFor("mindset-prod", "memex-building-itself")).toBe(
      false
    );
  });
});
