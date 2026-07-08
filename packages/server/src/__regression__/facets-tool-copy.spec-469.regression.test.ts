// spec-469 — the `facets` tool leads with its OUTCOME, not the word "facet".
//
// This pins the agent-facing copy so it can't silently revert:
//   - the description leads with the action ("Check which parts of your
//     Standards apply..."), not "Read your Memex's FACET vocabulary";
//   - it keeps an explicit `facets` + `facetBallot` anchor (dec-2), required
//     because dec-1/B keeps the tool + param names (no rename, no migration);
//   - the list-verb output drops the "Facet vocabulary for this Memex" header
//     and carries an assistant breadcrumb steering USER-facing narration;
//   - the change is confined: nothing is renamed and `formatRoutedStandards`
//     (the payoff readout, already action-language) is untouched.
//
// Each test tags both its implementation AC (ac-7..ac-12) and the scope AC it
// proves (ac-1..ac-6), so the board reflects the outcome and the mechanism.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { toolManifest } from "@memex/shared";
import { facetsTools, formatFacetList } from "../agent/handlers/facets.js";
import { formatRoutedStandards, type RoutingResult } from "../services/facet-routing.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-469/acs/ac-${n}`;
const ACTION_LEAD = "Check which parts of your Standards apply";

const facetsDesc = facetsTools[0].description;
const facetsManifest = toolManifest.find((t) => t.name === "facets");
const argsByName = new Map(toolManifest.map((t) => [t.name, t.args]));

describe("spec-469: facets tool copy leads with the outcome, keeps the facet anchor", () => {
  it("ac-9 / ac-1: handler description leads with the action, not 'facet vocabulary'", () => {
    tagAc(AC(9));
    tagAc(AC(1));
    expect(facetsDesc.startsWith(ACTION_LEAD)).toBe(true);
    expect(facetsDesc.toLowerCase()).not.toContain("facet vocabulary");
    expect(facetsDesc).not.toContain("Verb-dispatched");
  });

  it("ac-10 / ac-6: handler description carries the facets + facetBallot anchor", () => {
    tagAc(AC(10));
    tagAc(AC(6));
    expect(facetsDesc).toContain("facets");
    expect(facetsDesc).toContain("facetBallot");
  });

  it("ac-7 / ac-2: handler description and manifest summary agree in intent (no drift)", () => {
    tagAc(AC(7));
    tagAc(AC(2));
    expect(facetsManifest).toBeDefined();
    const summary = facetsManifest!.summary;
    // both lead with the same action and both carry the anchor
    expect(summary.startsWith(ACTION_LEAD)).toBe(true);
    expect(summary).toContain("facetBallot");
    expect(summary.toLowerCase()).not.toContain("read your memex's facet vocabulary");
    expect(facetsDesc.startsWith(ACTION_LEAD)).toBe(true);
  });

  it("ac-11 / ac-3: list output drops the old header and carries the narration breadcrumb", () => {
    tagAc(AC(11));
    tagAc(AC(3));
    const out = formatFacetList([
      { key: "security", name: "Security", description: "authz, tenancy, secrets" },
      { key: "db-migrations", name: "Database & migrations", description: "schema changes" },
    ]);
    expect(out).not.toContain("Facet vocabulary for this Memex");
    expect(out).toContain("Topics your Standards are tagged by (2)");
    // breadcrumb steers user-facing narration and names the anti-pattern
    expect(out).toContain("checking which parts of their Standards apply");
    expect(out).toContain('not as "reading facets"');
    // the vocabulary items still render
    expect(out).toContain("- security (Security): authz, tenancy, secrets");
  });

  it("ac-8: nothing is renamed — tool name, facetBallot arg, and facet-bearing tools intact", () => {
    tagAc(AC(8));
    expect(facetsTools[0].name).toBe("facets");
    expect(facetsManifest!.args).toBe("facets(verb, memex?)");
    // the retained param / arg still present on the five other facet-bearing tools
    expect(argsByName.get("create_task")).toContain("facetBallot");
    expect(argsByName.get("create_decision")).toContain("facetBallot");
    expect(argsByName.get("update_task")).toContain("facetBallot");
    expect(argsByName.get("update_decision")).toContain("facetBallot");
    expect(argsByName.get("add_clause")).toContain("facets");
    expect(argsByName.get("edit_clause")).toContain("facets");
  });

  it("ac-12: formatRoutedStandards is untouched — empty routing yields no readout, no breadcrumb", () => {
    tagAc(AC(12));
    expect(formatRoutedStandards({ surfaced: [] } as unknown as RoutingResult)).toBe("");
    // guard: the payoff readout source was NOT given the list breadcrumb and
    // still speaks action-language.
    const routingSrc = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../services/facet-routing.ts"),
      "utf8",
    );
    expect(routingSrc).toContain("govern this work");
    expect(routingSrc).not.toContain("reading facets");
  });

  it("ac-4 / ac-5: the change is confined — the other tool descriptions were not swept", () => {
    tagAc(AC(4));
    tagAc(AC(5));
    // the action lead is unique to `facets`: it did NOT leak into sibling tools
    const leaked = toolManifest.filter(
      (t) => t.name !== "facets" && t.summary.includes(ACTION_LEAD),
    );
    expect(leaked).toEqual([]);
  });
});
