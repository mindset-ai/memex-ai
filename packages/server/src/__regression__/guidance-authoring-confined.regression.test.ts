// Static companion to guidance-sole-author.integration.test.ts.
//
// THE INVARIANT (call-graph form): composeGuidanceEnvelope is the sole author of
// footer prose. The "prose builders" below produce footer words; after spec-219
// Phase 2 they may be CALLED only from `renderFooterSignal` (the signal→words
// mapper that composeGuidanceEnvelope owns). A reference anywhere else means a
// handler reached for the words directly — exactly what we forbid. This fails at
// author-time (no DB, no dispatch), the instant someone re-scatters a nudge.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "..", "agent", "tool-specs.ts"), "utf-8");

// renderFooterSignal's body spans from its header to the next top-level function
// (composeGuidanceEnvelope, which we place immediately after it). Span by anchor,
// not brace-matching — the prose templates contain `{ }` that would fool a
// counter.
const RFS_START = SRC.indexOf("async function renderFooterSignal(");
const RFS_END = SRC.indexOf("export async function composeGuidanceEnvelope(", RFS_START);

it("sanity: renderFooterSignal precedes composeGuidanceEnvelope", () => {
  expect(RFS_START).toBeGreaterThan(-1);
  expect(RFS_END).toBeGreaterThan(RFS_START);
});

// Each builder: the call token to hunt, and the regex that recognises its OWN
// definition/import line (allowed to live outside renderFooterSignal).
const PROSE_BUILDERS: { call: string; defLine: RegExp }[] = [
  { call: "COMPLETION_NUDGE", defLine: /export const COMPLETION_NUDGE/ },
  { call: "buildSketchBlock(", defLine: /import .*buildSketchBlock/ },
  { call: "relatedIssuesNudge(", defLine: /export function relatedIssuesNudge/ },
  { call: "nudgeForTransition(", defLine: /async function nudgeForTransition\(/ },
];

describe("footer prose builders are confined to renderFooterSignal", () => {
  for (const { call, defLine } of PROSE_BUILDERS) {
    it(`${call} is referenced only inside renderFooterSignal (or its own def/import)`, () => {
      const offenders: number[] = [];
      let idx = SRC.indexOf(call);
      while (idx !== -1) {
        const withinRenderer = idx >= RFS_START && idx < RFS_END;
        const lineStart = SRC.lastIndexOf("\n", idx) + 1;
        const lineEndRaw = SRC.indexOf("\n", idx);
        const lineEnd = lineEndRaw === -1 ? SRC.length : lineEndRaw;
        const line = SRC.slice(lineStart, lineEnd);
        const isOwnDecl = defLine.test(line);
        if (!withinRenderer && !isOwnDecl) {
          offenders.push(SRC.slice(0, idx).split("\n").length); // 1-based line no.
        }
        idx = SRC.indexOf(call, idx + 1);
      }
      expect(
        offenders,
        `${call} is used outside renderFooterSignal at tool-specs.ts line(s) ${offenders.join(", ")} — guidance prose must be authored only in composeGuidanceEnvelope/renderFooterSignal`,
      ).toEqual([]);
    });
  }
});
