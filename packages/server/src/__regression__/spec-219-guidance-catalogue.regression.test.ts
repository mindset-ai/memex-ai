// spec-219 ac-3 — the guidance catalogue is honoured: every guidance item that
// production appends today still has a live producer. Nothing is lost by
// omission. Source-text guards (no DB) pin each producer so a future refactor
// can't silently delete a nudge the catalogue (spec-219 §"Guidance catalogue")
// committed to keeping.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-219/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(SERVER_ROOT, "src", p), "utf-8");

// spec-366: handler implementation moved from tool-specs.ts into
// agent/handlers/*.ts (shared infra in shared.ts). Scan the catalogue file
// plus every handler module so these source guards still see the code.
const HANDLERS_DIR = join(SERVER_ROOT, "src", "agent", "handlers");
const toolSpecs = [
  read(join("agent", "tool-specs.ts")),
  ...readdirSync(HANDLERS_DIR)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => readFileSync(join(HANDLERS_DIR, n), "utf-8")),
].join("\n");
// spec-368 sol-4: formatter body moved to the neutral module; scan it there.
const formatters = read(join("formatting", "formatters.ts"));
const specTraffic = read(join("services", "spec-traffic.ts"));

describe("ac-3 — terse embedded nudges KEPT", () => {
  it("create_doc still pushes scope ACs", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/scope-type acceptance criteria/);
  });
  it("resolve_decision still pushes implementation ACs", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/create the implementation acceptance criteria/);
  });
  it("create_ac still reminds about ac-emission tagging", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/topic='ac-emission'/);
  });
  it("update_task terse still reports completion + unblocked dependents", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/Unblocked dependents/);
    expect(toolSpecs).toMatch(/COMPLETION_NUDGE/);
  });
});

describe("ac-3 — verbose blocks CHANGED (centralized), not dropped", () => {
  it("the get_doc coverage header is now seat-composed (verbose && get_doc)", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/ctx\.toolName === "get_doc"[\s\S]*?formatCoverageHeader\(/);
  });
  it("the handler footer nudges route through the footer slot as structured signals", () => {
    tagAc(AC(3));
    // spec-219 Phase 2 (sole-author): handlers no longer author footer prose;
    // they park a structured signal and composeGuidanceEnvelope owns the words.
    expect(toolSpecs).toMatch(/ctx\.footerSlot\.signal =/);
    expect(toolSpecs).not.toMatch(/ctx\.footerSlot\.content =/);
    expect(specTraffic).toMatch(/footerSlot/);
  });
  it("the InjectedBlock zone plumbing is KEPT (inert) — still present in the composer", () => {
    tagAc(AC(3));
    expect(formatters).toMatch(/InjectedBlock/);
    expect(formatters).toMatch(/zone === "header"/);
    expect(formatters).toMatch(/zone === "footer"/);
  });
});

describe("ac-3 — machine-footer internals KEPT / CHANGED", () => {
  it("FOOTER_DELIMITER ownership moved to the choke point (written once there)", () => {
    tagAc(AC(3));
    expect(specTraffic).toMatch(/\$\{FOOTER_DELIMITER\}\\n\$\{footer\}/);
  });
  it("phase guidance via toNudge is kept", () => {
    tagAc(AC(3));
    expect(formatters).toMatch(/toNudge\(/);
  });
  it("the terse build AC nag is kept", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/craftUntestedAcNag/);
  });
  it("the org_scaffold_additions overlay path is kept", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/getOrgBlocksForNudge/);
    expect(toolSpecs).toMatch(/orgBlocks/);
  });
  it("the NEW per-tool steer registry is present", () => {
    tagAc(AC(3));
    expect(toolSpecs).toMatch(/STEER_BY_TOOL/);
    expect(toolSpecs).toMatch(/function composeToolSteer/);
  });
});
