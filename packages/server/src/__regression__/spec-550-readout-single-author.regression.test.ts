// spec-550 dec-3 (ac-8) — the routed-standards readout has exactly ONE author.
//
// dec-3 kept the ranker declaration inline in `formatRoutedStandards` rather than moving
// one sentence into scaffold-data.ts, so a single rendered string keeps a single author.
// That property is only worth having if something holds it: a later tidy-up that lifts
// half the readout into the Scaffold would produce exactly the split dec-3 rejected, and
// nothing in the tree today would notice.
//
// SCOPE — read this before widening it. This guard protects spec-550's own property. It
// is NOT the fix for the pre-existing std-15 question (cl-68 confines tool-response
// footer prose to `composeGuidanceEnvelope`, and this readout is authored in a service,
// which predates that carve-out). That is flagged as drift c-4 on std-15 §8 and belongs
// to the standard's owner. If they rule the readout must move into the seat, this guard
// moves with it.
//
// WHAT IT COVERS, stated plainly because a guard that cannot tell "clean" from "I did
// not look" is not a check [per std-52]: it scans the two canonical prompt-prose homes
// (packages/shared/src/scaffold-data.ts and packages/server/src/agent/phases/**.md) plus
// the footer-prose seat (packages/server/src/agent/handlers/*.ts) for fragments of this
// readout. It does NOT scan the rest of the repo, and it does not police prose that is
// not the routed-standards readout.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const AC_8 = "mindset-prod/memex-building-itself/specs/spec-550/acs/ac-8";

const REPO_ROOT = join(__dirname, "../../../..");
const OWNER = join(REPO_ROOT, "packages/server/src/services/facet-routing.ts");

// Distinctive fragments of the readout — long enough that an incidental match elsewhere
// is not plausible, and spread across the heading, the dec-1 declaration, and an entry.
const READOUT_FRAGMENTS = [
  "govern this work",
  "The implicated sections are inlined below",
  "your facet ballot chose these candidates",
];

// The homes this prose must NOT reach. Each entry is [label, absolute path].
function forbiddenSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  const scaffold = join(REPO_ROOT, "packages/shared/src/scaffold-data.ts");
  out.push(["scaffold-data.ts", scaffold]);

  const phasesDir = join(REPO_ROOT, "packages/server/src/agent/phases");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md")) out.push([`phases/${entry.name}`, p]);
    }
  };
  if (existsSync(phasesDir)) walk(phasesDir);

  const handlersDir = join(REPO_ROOT, "packages/server/src/agent/handlers");
  for (const name of readdirSync(handlersDir).filter((n) => n.endsWith(".ts"))) {
    out.push([`handlers/${name}`, join(handlersDir, name)]);
  }

  return out;
}

describe("spec-550 dec-3 — the routed-standards readout has one author (ac-8)", () => {
  it("every fragment is composed in facet-routing.ts", () => {
    tagAc(AC_8);
    const owner = readFileSync(OWNER, "utf-8");
    for (const fragment of READOUT_FRAGMENTS) {
      expect(owner, `readout fragment missing from its owner: "${fragment}"`).toContain(fragment);
    }
  });

  it("no fragment appears in scaffold-data.ts, a phases/*.md, or a footer handler", () => {
    tagAc(AC_8);
    const offenders: string[] = [];
    for (const [label, path] of forbiddenSources()) {
      const src = readFileSync(path, "utf-8");
      for (const fragment of READOUT_FRAGMENTS) {
        if (src.includes(fragment)) offenders.push(`${label}: "${fragment}"`);
      }
    }
    expect(
      offenders,
      `readout prose found outside facet-routing.ts — dec-3 requires one author:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the scan actually reads its corpus (guards the guard)", () => {
    tagAc(AC_8);
    // Without this, a wrong path or an empty read would make the assertion above
    // vacuously green forever — clean and "I did not look" would be indistinguishable.
    const sources = forbiddenSources();
    expect(sources.length).toBeGreaterThan(5);
    for (const [label, path] of sources) {
      expect(readFileSync(path, "utf-8").length, `${label} read as empty`).toBeGreaterThan(0);
    }
    // And the fragments must be the kind of string that CAN be found by this scan —
    // proven by finding them in the owner, which the same reader reaches.
    expect(readFileSync(OWNER, "utf-8")).toContain(READOUT_FRAGMENTS[0]);
  });
});
