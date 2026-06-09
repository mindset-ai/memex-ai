// spec-193 — the two-pass classify-and-consult "tripwire" trigger.
//
// Regression guard for the three footer channels that carry the trigger, plus
// the per-memex scaffold scope and the scope-exclusion guarantees. Mirrors
// test-coverage-nudges.regression.test.ts: source-text + pure-projection
// assertions so the suite runs without the DB stack — the trigger lives in the
// scaffold DATA (shared) and the guidance JSON (server), both pure.
//
// Each `it` tags the spec-193 AC it proves (tagAc, full canonical ref) so the
// workspace records verification. The trap each guard closes: a future refactor
// strips the trigger prose from a channel, leaks a tenant specific into the
// product layer, drops the harness-green instruction, or re-opens the std-28
// laziness window the whole spec exists to close.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_SCAFFOLD,
  toNudge,
  toHandoffEssence,
  type GuidanceBlock,
} from "@memex/shared";
import { filterOrgBlocksForMemex } from "../services/scaffold-additions.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-193/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const SHARED_SRC = join(SERVER_ROOT, "..", "shared", "src");
const read = (p: string) => readFileSync(p, "utf-8");

const scaffoldData = read(join(SHARED_SRC, "scaffold-data.ts"));
const phasesJson = read(join(SERVER_ROOT, "src", "guidance", "phases.json"));
const testCoverageJson = read(
  join(SERVER_ROOT, "src", "guidance", "test-coverage.json"),
);
const scaffoldRoute = read(join(SERVER_ROOT, "src", "routes", "scaffold.ts"));
const mcpTools = read(join(SERVER_ROOT, "src", "mcp", "tools.ts"));
const formatters = read(join(SERVER_ROOT, "src", "mcp", "formatters.ts"));
const schema = read(join(SERVER_ROOT, "src", "db", "schema.ts"));

// The base tripwire block as the agent actually receives it, composed through
// the real nudge projection for each working phase. This is the footer text.
const specifyNudge = toNudge({ dataset: BASE_SCAFFOLD, phase: "specify" });
const buildNudge = toNudge({ dataset: BASE_SCAFFOLD, phase: "build" });
const verifyNudge = toNudge({ dataset: BASE_SCAFFOLD, phase: "verify" });
const planEssence = toHandoffEssence(BASE_SCAFFOLD, "specify") ?? "";
const verifyEssence = toHandoffEssence(BASE_SCAFFOLD, "verify") ?? "";

const TENANT_SPECIFICS = [
  "std-28",
  "make e2e-cold",
  "Playwright",
  "packages/ui/e2e",
];

const TRIPWIRE_CATEGORIES = [
  "test coverage",
  "end-to-end",
  "smoke",
  "deploy",
  "security",
  "architecture",
  "code style",
  "schema & migrations",
  "API design",
  "error handling",
  "performance",
  "accessibility",
  "CI / PR process",
  "documentation",
  "dependency management",
  "feature flags",
];

// ── dec-1: the two-pass tripwire shape ─────────────────────────────────────

describe("ac-1 — the trigger fires at two moments, both off the footer", () => {
  it("predictive pass rides the plan-handoff essence (classify the work AHEAD, cite standards)", () => {
    tagAc(AC(1));
    expect(planEssence).toMatch(/PREDICTIVE/);
    expect(planEssence).toMatch(/classify the work AHEAD/i);
    expect(planEssence).toMatch(/tripwire/i);
    // It pulls the routed standards into context before coding.
    expect(planEssence).toMatch(/standards into context BEFORE/i);
  });

  it("confirmatory pass rides the verify-spec essence (classify the actual DIFF, re-check)", () => {
    tagAc(AC(1));
    expect(verifyEssence).toMatch(/CONFIRMATORY/);
    expect(verifyEssence).toMatch(/classify the actual DIFF/i);
    expect(verifyEssence).toMatch(/tripwire/i);
  });

  it("both passes are the footer essence projection (toHandoffEssence), not the copy button only", () => {
    tagAc(AC(1));
    // toHandoffEssence IS the footer half of the spec-203 handoff node.
    expect(planEssence.length).toBeGreaterThan(0);
    expect(verifyEssence.length).toBeGreaterThan(0);
  });
});

describe("ac-8 — L0 functions with no tripwire-tag store", () => {
  it("routes to standards via classify-guided semantic search, not a tag store", () => {
    tagAc(AC(8));
    // The base block tells the agent to reach the standards with search_memex —
    // no per-standard tag lookup.
    expect(specifyNudge).toMatch(/search_memex\(\{ query, kind: 'standard' \}\)/);
    // No tag-store / bridge-table machinery anywhere in the scaffold data.
    expect(scaffoldData).not.toMatch(/tripwireTag|standardTripwireMap|TRIPWIRE_TO_STANDARD|bridge[- ]?table/i);
  });
});

describe("ac-9 — vocabulary delivered in the footer; classification agent-side; no hard-coded map", () => {
  it("all 16 tripwire categories are present in the composed footer", () => {
    tagAc(AC(9));
    expect(specifyNudge).toMatch(/Tripwires:/);
    for (const cat of TRIPWIRE_CATEGORIES) {
      expect(specifyNudge.toLowerCase()).toContain(cat.toLowerCase());
    }
  });

  it("the agent classifies its own work; there is no product-side standard→tripwire map", () => {
    tagAc(AC(9));
    expect(specifyNudge).toMatch(/classify the work against/i);
    expect(scaffoldData).not.toMatch(/const\s+\w*TRIPWIRE\w*MAP|standardsByTripwire/i);
  });
});

describe("ac-10 — semantic search stays a usable, non-exclusive route", () => {
  it("the base block names search as the always-on backstop", () => {
    tagAc(AC(10));
    expect(specifyNudge).toMatch(/backstop/i);
    expect(specifyNudge).toMatch(/semantic search over the standards stays the backstop/i);
  });
});

// ── dec-2: the three carrying channels through one footer ───────────────────

describe("ac-11 — three channels, emitted through renderSpecPhaseGuidance to both agents", () => {
  it("channel 1: the base GuidanceBlock carries the trigger on every working phase", () => {
    tagAc(AC(11));
    for (const nudge of [specifyNudge, buildNudge, verifyNudge]) {
      expect(nudge).toMatch(/classify-and-consult/i);
      expect(nudge).toMatch(/Tripwires:/);
    }
  });

  it("channel 2: the plan-handoff essence carries the predictive pass", () => {
    tagAc(AC(11));
    expect(planEssence).toMatch(/PREDICTIVE/);
  });

  it("channel 3: the verify-spec essence carries the confirmatory pass", () => {
    tagAc(AC(11));
    expect(verifyEssence).toMatch(/CONFIRMATORY/);
  });

  it("renderSpecPhaseGuidance composes BOTH toNudge and the handoff essence (one footer, both agents)", () => {
    tagAc(AC(11));
    expect(formatters).toMatch(/function renderSpecPhaseGuidance/);
    expect(formatters).toMatch(/toNudge\(\{/);
    expect(formatters).toMatch(/toHandoffEssence\(BASE_SCAFFOLD, phase\)/);
  });
});

describe("ac-12 — a regression test pins each carrying channel", () => {
  it("this suite pins all three channels (base block, plan essence, verify essence)", () => {
    tagAc(AC(12));
    // The pins above. This assertion documents that the three channels each have
    // a guard, mirroring test-coverage-nudges.regression.test.ts.
    expect(specifyNudge).toMatch(/Tripwires:/);
    expect(planEssence).toMatch(/PREDICTIVE/);
    expect(verifyEssence).toMatch(/CONFIRMATORY/);
  });
});

describe("ac-13 — the trigger is NOT added to MEMEX_AGENT_INSTRUCTIONS", () => {
  it("the instructions blob carries no tripwire / classify-and-consult content", () => {
    tagAc(AC(13));
    expect(mcpTools).toMatch(/MEMEX_AGENT_INSTRUCTIONS = `/);
    // The over-cap instructions constant was struck as a carrier (dec-2). The
    // trigger's unique terms must not appear in that file.
    expect(mcpTools).not.toMatch(/tripwire/i);
    expect(mcpTools).not.toMatch(/classify-and-consult/i);
  });
});

// ── ac-5: every channel pinned + instructions excluded ─────────────────────

describe("ac-5 — every footer channel pinned; MEMEX_AGENT_INSTRUCTIONS excluded", () => {
  it("base block + both essences are pinned, and the instructions blob is excluded", () => {
    tagAc(AC(5));
    expect(specifyNudge).toMatch(/Tripwires:/);
    expect(planEssence).toMatch(/PREDICTIVE/);
    expect(verifyEssence).toMatch(/CONFIRMATORY/);
    expect(mcpTools).not.toMatch(/tripwire/i);
  });
});

// ── ac-6: SaaS constraint — product layer stays tenant-agnostic ────────────

describe("ac-6 — the product prompting layer stays tenant-agnostic", () => {
  it("the base tripwire block carries no tenant tools, commands, CI shapes, or standards handles", () => {
    tagAc(AC(6));
    for (const specific of TENANT_SPECIFICS) {
      expect(specifyNudge).not.toContain(specific);
    }
    // ...but it DOES carry the generic vocabulary + the generic Memex search tool.
    expect(specifyNudge).toMatch(/Tripwires:/);
    expect(specifyNudge).toMatch(/search_memex/);
  });

  it("the two handoff essences carry no tenant specifics either", () => {
    tagAc(AC(6));
    for (const specific of TENANT_SPECIFICS) {
      expect(planEssence).not.toContain(specific);
      expect(verifyEssence).not.toContain(specific);
    }
  });
});

// ── dec-3: harness-green gate (prompt-only) ────────────────────────────────

describe("ac-14 — verify-spec essence + phases.json verify rubric require harnesses green before PR", () => {
  it("the verify-spec essence instructs harnesses GREEN before the PR is opened", () => {
    tagAc(AC(14));
    expect(verifyEssence).toMatch(/test harnesses must be GREEN before the PR/i);
  });

  it("the phases.json verify rubric instructs harnesses GREEN before any PR", () => {
    tagAc(AC(14));
    expect(phasesJson).toMatch(/test harnesses must be GREEN/);
    expect(phasesJson).toMatch(/before any PR/i);
  });
});

describe("ac-15 — no new structural attestation; CI stays the gate, 193 is prompt text only", () => {
  it("no harness-attestation symbol/route/column was introduced", () => {
    tagAc(AC(15));
    // The instruction is prose; there is no in-Memex structural check.
    for (const src of [scaffoldData, phasesJson, schema, scaffoldRoute]) {
      expect(src).not.toMatch(/harnessGreen|attestHarness|harness_attestation|harnessAttestation/i);
    }
    // The essence frames CI as the enforcement backstop, not an in-app gate.
    expect(verifyEssence).toMatch(/CI is the enforcement backstop/i);
  });
});

// ── dec-4: e2e complementary, not "instead of" ─────────────────────────────

describe("ac-4 / ac-16 — e2e guidance is complementary to service tests, never 'instead of'", () => {
  it("test-coverage.json keeps Pattern 2 intact AND adds the complement counterweight", () => {
    tagAc(AC(16));
    // Pattern 2 (the anti-pattern) is left intact.
    expect(testCoverageJson).toMatch(/Pattern 2: deferring scope ACs to E2E/);
    // The new counterweight: complementary, "as well as", never "instead of".
    expect(testCoverageJson).toMatch(/Complement, not substitute/i);
    expect(testCoverageJson).toMatch(/as well as/);
    expect(testCoverageJson).toMatch(/preferred verification layer for scope ACs/i);
    expect(testCoverageJson).toMatch(/never .{0,40}instead of/i);
  });

  it("service tests stay the preferred AC layer; e2e journeys are ADDITIONALLY required", () => {
    tagAc(AC(4));
    expect(testCoverageJson).toMatch(/Service \/ integration tests remain the/);
    expect(testCoverageJson).toMatch(/additionally/i);
  });
});

// ── dec-5 / dec-7: passive signal, no dev tool, no authoring ────────────────

describe("ac-2 / ac-17 — uncovered tripwire never blocks the dev; no gap tool; agent never authors", () => {
  it("the base block tells the agent an uncovered wire just proceeds, and to never author a standard", () => {
    tagAc(AC(2));
    expect(specifyNudge).toMatch(/just proceed/i);
    expect(specifyNudge).toMatch(/never author a standard/i);
  });

  it("no report_standard_gap (or equivalent) dev-facing gap-report tool exists", () => {
    tagAc(AC(17));
    expect(mcpTools).not.toMatch(/report_standard_gap|reportStandardGap/i);
    expect(scaffoldData).not.toMatch(/report_standard_gap/i);
    // No prompting instructs the agent to author a standard for an uncovered wire.
    expect(specifyNudge).toMatch(/you never author a standard to fill it/i);
  });
});

describe("ac-18 — uncovered-tripwire occurrence recoverable from the persisted footer audit", () => {
  it("the footer is persisted to mcp_tool_calls.footer_text (the passive substrate)", () => {
    tagAc(AC(18));
    expect(schema).toMatch(/footerText: text\("footer_text"\)/);
  });

  it("no NEW dev-facing capture path was added for the gap signal", () => {
    tagAc(AC(18));
    expect(mcpTools).not.toMatch(/report_standard_gap/i);
    expect(scaffoldRoute).not.toMatch(/gap[-_ ]?report|uncoveredTripwire/i);
  });
});

describe("ac-21 — no product starter standards, no agent-authored gap-filling standards", () => {
  it("the change adds the consult trigger only — authoring standards stays out of scope", () => {
    tagAc(AC(21));
    // The trigger explicitly disclaims authoring; coverage is admin governance.
    expect(specifyNudge).toMatch(/admin \/ setup job/i);
    expect(specifyNudge).toMatch(/never author a standard/i);
    expect(mcpTools).not.toMatch(/report_standard_gap/i);
  });
});

// ── dec-6 / dec-8: per-memex scope merge, hybrid overlay, no new docType ────

describe("ac-19 — org_scaffold_additions per-memex scope merges account-wide + this memex", () => {
  const accountWide: GuidanceBlock = {
    kind: "guidance_block",
    source: "org",
    target: { phase: "build" },
    text: "ACCOUNT-WIDE house style",
    rationale: "r",
    enabled: true,
    order: 0,
  };
  const m1: GuidanceBlock = { ...accountWide, text: "M1 only", memexId: "m1" };
  const m2: GuidanceBlock = { ...accountWide, text: "M2 only", memexId: "m2" };
  const all = [accountWide, m1, m2];

  it("a NULL memexId row applies account-wide (existing behaviour preserved)", () => {
    tagAc(AC(19));
    // Resolving for m1 keeps the account-wide row...
    expect(filterOrgBlocksForMemex(all, "m1").map((b) => b.text)).toContain(
      "ACCOUNT-WIDE house style",
    );
    // ...and resolving with no bound memex keeps ONLY account-wide rows.
    expect(filterOrgBlocksForMemex(all, undefined).map((b) => b.text)).toEqual([
      "ACCOUNT-WIDE house style",
    ]);
  });

  it("a memexId-scoped row applies ONLY to that memex (no cross-memex bleed)", () => {
    tagAc(AC(19));
    const forM1 = filterOrgBlocksForMemex(all, "m1").map((b) => b.text);
    expect(forM1).toContain("M1 only");
    expect(forM1).not.toContain("M2 only");
  });

  it("resolution MERGES account-wide + per-memex at query time", () => {
    tagAc(AC(19));
    expect(filterOrgBlocksForMemex(all, "m1").map((b) => b.text).sort()).toEqual(
      ["ACCOUNT-WIDE house style", "M1 only"],
    );
  });

  it("the schema carries the memex_id column with a covering index", () => {
    tagAc(AC(19));
    expect(schema).toMatch(/memexId: uuid\("memex_id"\)/);
    expect(schema).toMatch(/org_scaffold_additions_org_id_memex_id_idx/);
  });
});

describe("ac-7 / ac-20 — tenant extension flows through org_scaffold_additions via toNudge, no new docType", () => {
  it("a per-memex org block merges into the composed footer for that memex", () => {
    tagAc(AC(7));
    const orgBlock: GuidanceBlock = {
      kind: "guidance_block",
      source: "org",
      target: { phase: "build" },
      text: "TENANT EXTRA tripwire: licensing",
      rationale: "r",
      enabled: true,
      order: 100,
      memexId: "m1",
    };
    const merged = filterOrgBlocksForMemex([orgBlock], "m1");
    const nudge = toNudge({
      dataset: BASE_SCAFFOLD,
      phase: "build",
      orgBlocks: merged,
    });
    // The tenant extension reaches the agent through the SAME footer projection,
    // with no deploy and no new docType.
    expect(nudge).toContain("TENANT EXTRA tripwire: licensing");
  });

  it("tenant prompting still flows via org_scaffold_additions — no new 'scaffold' docType", () => {
    tagAc(AC(20));
    // The route is the existing org_scaffold_additions REST surface; toNudge
    // merges orgBlocks. No documents.docType of 'scaffold' was introduced.
    expect(scaffoldRoute).toMatch(/org_scaffold_additions|scaffold\/additions/);
    expect(schema).not.toMatch(/'scaffold'.*docType|docType.*'scaffold'/);
  });
});

// ── ac-3: the e2e instance — product enablers that lead the agent to std-28 ─

describe("ac-3 — the e2e loop's product enablers (tenant std-28 + journey completes it)", () => {
  it("the predictive pass tells the agent to surface journey / test work up front", () => {
    tagAc(AC(3));
    expect(planEssence).toMatch(/journey \/ test \/ migration work/i);
  });

  it("the agent is told the harness must be green before the PR, and journeys are required where standards mandate", () => {
    tagAc(AC(3));
    expect(verifyEssence).toMatch(/test harnesses must be GREEN before the PR/i);
    expect(testCoverageJson).toMatch(/e2e journeys.*additionally|additionally.*journey/i);
  });
});
