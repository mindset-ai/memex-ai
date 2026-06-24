// spec-340 t-9 / dec-2 — the routing reconciliation guard.
//
// spec-193 forbids a hand-maintained standard↔tripwire map in the SCAFFOLD layer.
// spec-340 reverses the no-stored-tags default for ROUTING — but with
// AUTO-ASSIGNED clause→facet tags in the DB, not a hand-curated scaffold map. This
// guard pins both halves so a future refactor can't silently re-forbid the
// permitted mechanism OR re-introduce the forbidden one. Source-text assertions
// (no DB), mirroring spec-193-tripwire.regression.test.ts.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-340/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(p, "utf8");
const scaffoldData = read(join(SERVER_ROOT, "..", "shared", "src", "scaffold-data.ts"));
const schema = read(join(SERVER_ROOT, "src", "db", "schema.ts"));
const classifier = read(join(SERVER_ROOT, "src", "services", "facet-classifier.ts"));
const routing = read(join(SERVER_ROOT, "src", "services", "facet-routing.ts"));

describe("spec-340 dec-2 routing reconciliation (ac-13)", () => {
  it("preserves spec-193's intent — no HAND-MAINTAINED standard↔facet map in the scaffold layer", () => {
    tagAc(AC(13));
    expect(scaffoldData).not.toMatch(
      /standardTripwireMap|standardsByTripwire|standardFacetMap|facetToStandard|facetStandardBridge|bridge[- ]?table/i,
    );
  });

  it("permits the spec-340 mechanism — AUTO-ASSIGNED clause→facet tags in the DB, routed by a join", () => {
    tagAc(AC(13));
    // The tag store is a DB table (auto-assigned rows), not scaffold prose.
    expect(schema).toMatch(/"standard_clause_facets"/);
    expect(schema).toMatch(/export const standardClauseFacets/);
    // The tags are written by the CLASSIFIER (auto-assigned at authoring time),
    // never hand-curated.
    expect(classifier).toMatch(/insert\(standardClauseFacets\)/);
    // Routing resolves over those stored tags via a DB join (not search, not a map).
    expect(routing).toMatch(/\.from\(standardClauseFacets\)/);
  });
});
