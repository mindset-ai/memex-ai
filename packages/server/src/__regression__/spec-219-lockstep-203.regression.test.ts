// spec-219 ac-13 — lockstep with spec-203.
//
// The envelope work INVERTS spec-203 ac-13 ("formatFullDocState is the single
// composer of the doc-state envelope, with NO tool-name conditionals; the four
// decorating tools pass InjectedBlocks"). spec-219's single seat composes the
// envelope PER-TOOL and the choke point attaches it, so formatFullDocState
// composes neither header nor footer. These source-text guards pin the code side
// of the inversion; the Memex side (spec-203 ac-13 retired, ac-15 softened,
// spec-203 shows no failing ACs) is reconciled via the AC tools in the SAME
// change set and confirmed with list_acs(spec-203).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-219/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(SERVER_ROOT, "src", p), "utf-8");
const toolSpecs = read(join("agent", "tool-specs.ts"));
const formatters = read(join("mcp", "formatters.ts"));

describe("spec-219 ac-13 — the per-tool seat inverts spec-203 ac-13", () => {
  it("the seat composes the envelope PER-TOOL (tool-name conditionals)", () => {
    tagAc(AC(13));
    const seat = toolSpecs.slice(
      toolSpecs.indexOf("export async function composeGuidanceEnvelope("),
      toolSpecs.indexOf("async function craftUntestedAcNag("),
    );
    // Inverts spec-203 ac-13's "NO tool-name conditionals": the header is gated
    // on the dispatching tool, and per-tool steering keys on the tool.
    expect(seat).toMatch(/ctx\.toolName === "get_doc"/);
    expect(toolSpecs).toMatch(/const STEER_BY_TOOL/);
    expect(toolSpecs).toMatch(/function composeToolSteer/);
  });

  it("formatFullDocState composes neither a header nor a footer (no longer the single composer)", () => {
    tagAc(AC(13));
    expect(formatters).toMatch(/the footer is NO LONGER composed here/i);
    const bodyFn = formatters.slice(
      formatters.indexOf("export function formatFullDocState"),
      formatters.indexOf("// Document List"),
    );
    // The body renderer emits no machine footer (no delimiter) and no
    // AC-coverage header — the seat owns both.
    expect(bodyFn).not.toMatch(/FOOTER_DELIMITER/);
    expect(bodyFn).not.toMatch(/formatCoverageHeader/);
    expect(bodyFn).not.toMatch(/formatSpecGuidance\(/);
  });
});
