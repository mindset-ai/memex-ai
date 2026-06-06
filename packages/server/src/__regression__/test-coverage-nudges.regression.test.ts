// Regression guard: the three "test-coverage discipline" nudge channels stay
// wired into the MCP surface so agents see the coverage gap they're prone to
// shrug off.
//
// Channel 1 — list_acs surfaces per-AC test counts + verification state, plus
//             an aggregate "X% covered / N UNTESTED" header and a tail nudge
//             pointing at the guidance topic when any ACs are at 0 tests.
// Channel 2 — phase-transition advice (specify→build, build→verify) gets a
//             coverage-aware paragraph appended via formatCoverageNudge.
//             get_doc(verbose) on a Spec gets a coverage header prepended
//             via formatCoverageHeader.
// Channel 4 — get_information(topic='test-coverage') exists and names the
//             three lazy patterns by their canonical labels.
//
// The trap this guards: a future refactor strips the "UNTESTED" call-out, or
// drops the guidance-topic reference, or removes the formatCoverageNudge
// wiring from nudgeForTransition. Any of those silently re-opens the agent
// laziness window the trio was added to close.
//
// Source-text assertions are used (over runtime assertions) so the test runs
// without spinning up the full DB stack — channels 1/2 already have
// behaviour-level coverage in the verification-enrichment service tests; this
// guard exists to pin the *wiring* in tool-specs.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_ROOT = join(__dirname, "..", "..");
const TOOL_SPECS = join(SERVER_ROOT, "src", "agent", "tool-specs.ts");
const GUIDANCE = join(SERVER_ROOT, "src", "guidance", "test-coverage.json");

const toolSpecs = readFileSync(TOOL_SPECS, "utf-8");

describe("Channel 1 — list_acs surfaces coverage gap", () => {
  it("uses the verification-enriched service, not the bare list", () => {
    expect(toolSpecs).toMatch(/listAcsForBriefWithVerification/);
  });

  it("emits a per-AC test count line with UNTESTED for 0-test ACs", () => {
    expect(toolSpecs).toMatch(/0 tests · UNTESTED/);
    expect(toolSpecs).toMatch(/verificationState/);
  });

  it("emits an aggregate covered/verified header at the top", () => {
    expect(toolSpecs).toMatch(/% covered/);
    expect(toolSpecs).toMatch(/% verified \(of covered\)/);
  });

  it("emits a tail nudge pointing at the test-coverage topic when any AC is untested", () => {
    expect(toolSpecs).toMatch(/get_information\(topic='test-coverage'\)/);
  });
});

describe("Channel 2 — phase-transition advice carries a coverage paragraph", () => {
  it("defines formatCoverageNudge that targets specify→build and build→verify", () => {
    expect(toolSpecs).toMatch(/async function formatCoverageNudge/);
    expect(toolSpecs).toMatch(/specify→build/);
    expect(toolSpecs).toMatch(/build→verify/);
  });

  it("specify→build advice tells the agent to write tagged tests for every active AC", () => {
    expect(toolSpecs).toMatch(
      /every active AC should have at least one tagged test before verify/,
    );
  });

  it("build→verify advice flags untested ACs as silent gaps", () => {
    expect(toolSpecs).toMatch(/silent gaps in the verification story/);
    expect(toolSpecs).toMatch(/RED tagged tests/);
  });

  it("nudgeForTransition wires formatCoverageNudge into the appended advice", () => {
    // The phase-transition advice block must call the helper — otherwise the
    // build/verify nudges land without the coverage paragraph.
    expect(toolSpecs).toMatch(
      /const coverageSection = await formatCoverageNudge\(/,
    );
  });

  it("defines formatCoverageHeader for verbose get_doc on Specs", () => {
    expect(toolSpecs).toMatch(/async function formatCoverageHeader/);
    expect(toolSpecs).toMatch(/\*\*AC coverage:\*\*/);
  });

  it("verbose get_doc prepends the coverage header for Specs", () => {
    // The wiring lives inside the get_doc handler — assert the helper is
    // called there and its result is concatenated with the formatted state.
    expect(toolSpecs).toMatch(
      /const coverageHeader = await formatCoverageHeader\([\s\S]*?doc\.docType,[\s\S]*?\);/,
    );
    expect(toolSpecs).toMatch(
      /\$\{coverageHeader\}\$\{await formatState\(url, state, ctx\)\}/,
    );
  });
});

describe("Channel 4 — test-coverage guidance topic", () => {
  const topic = JSON.parse(readFileSync(GUIDANCE, "utf-8")) as {
    title: string;
    when_to_read: string;
    body: string;
  };

  it("has a title that frames the discipline as scope-not-just-this-turn", () => {
    expect(topic.title).toMatch(/scope what you test/i);
  });

  it("when_to_read covers the build→verify activation moments", () => {
    expect(topic.when_to_read).toMatch(/build/);
    expect(topic.when_to_read).toMatch(/verify/);
    expect(topic.when_to_read).toMatch(/list_acs/);
  });

  it("body names Pattern 1: scoping tests to the current turn's task", () => {
    expect(topic.body).toMatch(/Pattern 1: scoping tests to/i);
  });

  it("body names Pattern 2: deferring scope ACs to E2E", () => {
    expect(topic.body).toMatch(/Pattern 2: deferring scope ACs to E2E/i);
  });

  it("body names Pattern 3: silently no-emitting tests", () => {
    expect(topic.body).toMatch(/Pattern 3: silently no-emitting tests/i);
  });

  it("body articulates the RED-tests-now rule", () => {
    // The load-bearing instruction: write RED tests for every active AC even
    // when this turn only implements some of them. If a refactor waters this
    // down to "tests for the ones you implement", the discipline collapses.
    expect(topic.body).toMatch(/RED/);
    expect(topic.body).toMatch(/every active AC/i);
  });

  it("body warns about the silent no-emit failure mode", () => {
    expect(topic.body).toMatch(/tagAc/);
    expect(topic.body).toMatch(/\[ac-emit\]/);
  });
});
