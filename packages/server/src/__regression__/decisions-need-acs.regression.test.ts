// Regression guard: the "every resolved decision needs ≥1 implementation AC"
// discipline is wired into every surface that should be teaching it.
//
// Five surfaces, each carrying its own piece of the discipline. If any one
// of these silently regresses, the agent stops being trained to author
// implementation ACs after `resolve_decision` and naked-resolved-decisions
// leak into build.
//
// Channel A — JIT nudge on resolve_decision (tool-specs.ts handler)
// Channel B — Guidance topic body (guidance/decisions-need-acs.json)
// Channel C — list_acs header line + tail nudge naming naked decisions
// Channel D — assess_brief({target:'build'}) rubric markdown + fact +
//             nudge (BASE_SCAFFOLD.transitions in @memex/shared scaffold-data
//             + phase-assessment.ts).
// Channel E — Shared helper export (services/acs.ts:listResolvedDecisionImplAcCoverage)
//
// Source-text assertions so the test runs without spinning up the full DB
// stack — behaviour-level coverage of the helper lives in
// `decisions-need-acs.integration.test.ts`; this guard pins the wiring in
// each surface.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_SCAFFOLD } from "@memex/shared";

const SERVER_ROOT = join(__dirname, "..", "..");
const TOOL_SPECS = join(SERVER_ROOT, "src", "agent", "tool-specs.ts");
const GUIDANCE = join(
  SERVER_ROOT,
  "src",
  "guidance",
  "decisions-need-acs.json",
);
const PHASE_ASSESS = join(
  SERVER_ROOT,
  "src",
  "services",
  "phase-assessment.ts",
);
const ACS_SERVICE = join(SERVER_ROOT, "src", "services", "acs.ts");

const toolSpecs = readFileSync(TOOL_SPECS, "utf-8");
const phaseAssess = readFileSync(PHASE_ASSESS, "utf-8");
const acsService = readFileSync(ACS_SERVICE, "utf-8");

// b-68 t-7: the specify→build rubric prose used to live in
// `phases/specify/transitions.md` and was read from disk here. That file is
// retired; the prose is now a `TransitionRubric` record on
// `BASE_SCAFFOLD.transitions`. Read it through the projection so the regression
// guard pins the same content from its new home.
const rubric =
  BASE_SCAFFOLD.transitions.find((t) => t.transition === "build")?.text ?? "";

describe("Channel A — resolve_decision JIT nudge", () => {
  it("appends a 'next: create implementation acceptance criteria' nudge to the response", () => {
    expect(toolSpecs).toMatch(/create the implementation acceptance criteria/);
  });

  it("shows the create_ac syntax with parent_decision_ref pre-filled to the dec ref", () => {
    expect(toolSpecs).toMatch(
      /create_ac\(\{[^}]*kind:\s*'implementation'[^}]*parent_decision_ref:/,
    );
  });

  it("cites the decisions-need-acs guidance topic", () => {
    expect(toolSpecs).toMatch(
      /get_information\(topic='decisions-need-acs'\)/,
    );
  });

  it("warns that build-readiness will refuse specify→build without the ACs", () => {
    expect(toolSpecs).toMatch(/build-readiness will refuse/i);
  });
});

describe("Channel B — guidance topic body", () => {
  const topic = JSON.parse(readFileSync(GUIDANCE, "utf-8")) as {
    title: string;
    when_to_read: string;
    body: string;
  };

  it("title frames the rule as 'commitment without a verification path'", () => {
    expect(topic.title).toMatch(/commitment without a verification path/i);
  });

  it("when_to_read points at the resolve_decision moment", () => {
    expect(topic.when_to_read).toMatch(/resolve_decision/);
    expect(topic.when_to_read).toMatch(/assess_spec/);
  });

  it("body names the rule explicitly", () => {
    expect(topic.body).toMatch(
      /every resolved decision must have at least one child implementation AC/i,
    );
  });

  it("body cites the build-readiness gate", () => {
    expect(topic.body).toMatch(/specify→build/);
    expect(topic.body).toMatch(/hold/);
  });

  it("body explains the asymmetry the rule fixes (scope-only nudge → both)", () => {
    expect(topic.body).toMatch(/scope/i);
    expect(topic.body).toMatch(/implementation/i);
    expect(topic.body).toMatch(/asymmetry/i);
  });

  it("body pairs with decisions-vs-tasks and test-coverage", () => {
    expect(topic.body).toMatch(/decisions-vs-tasks/);
    expect(topic.body).toMatch(/test-coverage/);
  });
});

describe("Channel C — list_acs surfaces the naked-decisions gap", () => {
  it("imports listResolvedDecisionImplAcCoverage from the service", () => {
    expect(toolSpecs).toMatch(/listResolvedDecisionImplAcCoverage/);
  });

  it("renders a 'resolved decision · with implementation ACs' line in the header", () => {
    expect(toolSpecs).toMatch(/resolved decision/);
    expect(toolSpecs).toMatch(/with implementation ACs/);
  });

  it("surfaces NAKED decision handles on the header when any are missing ACs", () => {
    expect(toolSpecs).toMatch(/NAKED:/);
  });

  it("tail nudge points at the decisions-need-acs guidance topic", () => {
    expect(toolSpecs).toMatch(
      /get_information\(topic='decisions-need-acs'\)/,
    );
  });
});

describe("Channel D — assess_brief build rubric + fact + nudge", () => {
  it("rubric names the implementation-AC-per-resolved-decision check as a hold trigger", () => {
    expect(rubric).toMatch(/Implementation ACs per resolved decision/i);
    expect(rubric).toMatch(/commitment without a verification path/i);
    expect(rubric).toMatch(/decisions-need-acs/);
  });

  it("rubric 'what good looks like' includes the impl-AC coverage state", () => {
    expect(rubric).toMatch(/active implementation AC linked/i);
  });

  it("phase-assessment defines DecisionAcCoverageFact and surfaces it on facts", () => {
    expect(phaseAssess).toMatch(/DecisionAcCoverageFact/);
    expect(phaseAssess).toMatch(/resolvedDecisionAcCoverage/);
  });

  it("phase-assessment build-target nudge lists naked decisions inline", () => {
    expect(phaseAssess).toMatch(
      /Resolved decisions without implementation ACs/,
    );
    expect(phaseAssess).toMatch(/Specify→build is a hold/);
  });

  it("formatPhaseAssessment renders the implementation-AC coverage block", () => {
    expect(phaseAssess).toMatch(
      /Resolved-decision implementation-AC coverage/,
    );
    expect(phaseAssess).toMatch(/NAKED — no implementation AC/);
  });
});

describe("Channel E — shared helper is exported and used by both surfaces", () => {
  it("acs.ts exports listResolvedDecisionImplAcCoverage", () => {
    expect(acsService).toMatch(
      /export async function listResolvedDecisionImplAcCoverage/,
    );
  });

  it("helper filters to (parent_kind='decision', ac.kind='implementation', ac.status='active')", () => {
    // Pinning the three filter clauses — drop any one and the rule silently
    // changes shape (counts proposed/rejected/superseded ACs, counts scope
    // ACs, counts ACs linked to non-decisions). Each is load-bearing.
    expect(acsService).toMatch(/eq\(acParentLinks\.parentKind,\s*"decision"\)/);
    expect(acsService).toMatch(/eq\(acs\.kind,\s*"implementation"\)/);
    expect(acsService).toMatch(/eq\(acs\.status,\s*"active"\)/);
  });

  it("phase-assessment uses the shared helper, not a duplicate inline join", () => {
    expect(phaseAssess).toMatch(/listResolvedDecisionImplAcCoverage/);
  });
});
