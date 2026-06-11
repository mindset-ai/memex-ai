// spec-243 ac-6: the deploy notification names the specs and PRs that shipped.
// These exercise the pure parsing/message functions directly (the script's
// main() is import-guarded, so importing it posts nothing).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
// scripts/ lives outside the package; import the .mjs by relative path.
import {
  extractSpecRefs,
  extractPrNumbers,
  buildDeployMessage,
} from "../../../../scripts/canary/deploy-notify.mjs";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-243";

// A realistic merge-commit set (shape of github.event.commits): the actual
// subjects from the develop→main promotion earlier in this work.
const COMMITS = [
  { message: "Merge pull request #126 from mindset-ai/spec-230-overview-parity" },
  { message: "feat: in-app Spec creation reaches web↔MCP parity (spec-230)" },
  { message: "Merge pull request #124 from mindset-ai/spec-222-voice-latency" },
  { message: "feat(voice): caching + latency logs + personas (spec-222)" },
  { message: "Merge pull request #116 from mindset-ai/spec-122-pulse-board" },
  { message: "feat(pulse): activity board (spec-122)" },
  { message: "fix(rls): exclude memex_emission_keys from RLS (spec-243)" },
];

describe("spec-243: deploy notification enrichment", () => {
  it("ac-6: extracts unique spec handles, sorted numerically", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    expect(extractSpecRefs(COMMITS.map((c) => c.message).join("\n"))).toEqual([
      "spec-122",
      "spec-222",
      "spec-230",
      "spec-243",
    ]);
  });

  it("ac-6: spec extraction is case-insensitive and de-duplicates", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    expect(extractSpecRefs("SPEC-7 spec-7 Spec-7 spec-12")).toEqual([
      "spec-7",
      "spec-12",
    ]);
  });

  it("ac-6: extracts merged PR numbers", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    expect(extractPrNumbers(COMMITS.map((c) => c.message).join("\n"))).toEqual([
      116, 124, 126,
    ]);
  });

  it("ac-6: success message carries clickable spec links + PR list", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const msg = buildDeployMessage({
      host: "memex.ai",
      outcome: "success",
      actor: "wic",
      runUrl: "https://example/run",
      commits: COMMITS,
    });
    expect(msg).toContain("🚀 *memex.ai* deployed (by wic)");
    expect(msg).toContain("7 commits, 3 PRs (#116, #124, #126)");
    // Clickable Slack link to the spec's page in the prod memex-building-itself.
    expect(msg).toContain(
      "<https://memex.ai/mindset-prod/memex-building-itself/specs/spec-122|spec-122>",
    );
    expect(msg).toContain("<https://example/run|Details>");
  });

  it("ac-6: failed deploy uses the red register but still lists specs", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const msg = buildDeployMessage({
      host: "int.memex.ai",
      outcome: "failure",
      actor: "wic",
      runUrl: "https://example/run",
      commits: COMMITS,
    });
    expect(msg).toContain("🛑 Deploy to *int.memex.ai* did not complete");
    expect(msg).toContain("spec-243");
  });

  it("ac-6: a deploy with no spec tags says so rather than lying", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    const msg = buildDeployMessage({
      host: "memex.ai",
      outcome: "success",
      actor: "wic",
      runUrl: "https://example/run",
      commits: [{ message: "chore: bump dependency" }],
    });
    expect(msg).toContain("_No spec-tagged commits in this release._");
  });
});
