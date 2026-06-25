// spec-251 — static pins for the mindset-website surface's ops artifacts.
//
//   t-5 (dec-1): the corpus-refresh workflow is a SIBLING of the memex-website
//     one — guide-content-mindset-website-refresh.yml. These tests pin the
//     load-bearing facts of BOTH files: the new workflow's dispatch contract,
//     bounded/non-gating posture, and env-invariant source URL (ac-7/ac-8/ac-10),
//     and that the proven memex-website workflow kept its shape (ac-9).
//   t-7: release-sdk.mjs gained a per-host destination; the memex-website target
//     (the default) keeps its js/ + assets/ layout byte-for-byte semantics, and
//     the mindset-website target vendors into public/guide/ (ac-13).
//
// Static scans, same posture as the repo's other deploy-wiring regression tests:
// the YAML/scripts are config, so the test reads the artifact itself.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-251";
const AC5 = `${SPEC}/acs/ac-5`;
const AC7 = `${SPEC}/acs/ac-7`;
const AC8 = `${SPEC}/acs/ac-8`;
const AC9 = `${SPEC}/acs/ac-9`;
const AC10 = `${SPEC}/acs/ac-10`;
const AC13 = `${SPEC}/acs/ac-13`;

// __regression__ → src → server → packages → repo root.
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");

const MINDSET_WF = ".github/workflows/guide-content-mindset-website-refresh.yml";
const MEMEX_WF = ".github/workflows/guide-content-website-refresh.yml";

describe("guide-content-mindset-website-refresh.yml (spec-251 t-5, dec-1)", () => {
  it("exists with the agreed dispatch contract + manual trigger (ac-7)", () => {
    tagAc(AC7);
    tagAc(AC5);
    const wf = read(MINDSET_WF);
    // The dispatch event name IS the cross-repo contract recorded in both Specs.
    expect(wf).toContain("repository_dispatch");
    expect(wf).toContain("types: [mindset-website-content-changed]");
    // Manual re-trigger with the prod/int env choice.
    expect(wf).toContain("workflow_dispatch");
    expect(wf).toContain("options: [prod, int]");
    // It runs the mindset-website import.
    expect(wf).toContain("--surface=mindset-website");
  });

  it("is bounded (600s) and non-gating (ac-8)", () => {
    tagAc(AC8);
    const wf = read(MINDSET_WF);
    expect(wf).toContain("timeout 600");
    expect(wf).toMatch(/\|\| echo "⚠ mindset-website corpus refresh timed out or failed/);
  });

  it("uses the LIVE www.mindset.ai source for BOTH envs — no env-switched source (ac-10)", () => {
    tagAc(AC10);
    const wf = read(MINDSET_WF);
    expect(wf).toContain('SRC="https://www.mindset.ai/llms-full.txt"');
    // The memex-website sibling switches SRC by env; this one must NOT (mindset.ai
    // has no int variant). No conditional source assignment anywhere.
    expect(wf).not.toMatch(/if \[ "\$\{ENV\}" = "prod" \]; then SRC=/);
    expect(wf).not.toContain("int.mindset.ai");
  });

  it("authenticates like the sibling: WIF + cloud-sql-proxy, never the public endpoint (ac-7)", () => {
    tagAc(AC7);
    const wf = read(MINDSET_WF);
    expect(wf).toContain("google-github-actions/auth@v3");
    expect(wf).toContain("GCP_WORKLOAD_IDENTITY_PROVIDER");
    expect(wf).toContain("cloud-sql-proxy");
    // The import goes straight to Postgres via the proxy — no step ever curls
    // the public endpoint (the only /guide/v1 mention is the explanatory comment).
    expect(wf).not.toMatch(/curl[^\n]*\/guide\/v1/);
  });

  it("BOTH refresh workflows grant id-token: write — WIF cannot mint an OIDC token without it", () => {
    tagAc(AC7);
    // Found by spec-251's first live dispatch: the spec-222 workflow shipped
    // without a permissions block and had never run; every WIF auth failed.
    for (const path of [MINDSET_WF, MEMEX_WF]) {
      const wf = read(path);
      expect(wf, `${path} must grant id-token: write for WIF`).toMatch(
        /permissions:\s*\n\s*contents: read\s*\n\s*id-token: write/,
      );
    }
  });
});

describe("the memex-website refresh path is untouched (spec-251 dec-1 → ac-9)", () => {
  it("guide-content-website-refresh.yml keeps its load-bearing shape", () => {
    tagAc(AC9);
    const wf = read(MEMEX_WF);
    // Its dispatch contract, surface, and env-switched source are exactly as
    // spec-222 t-13 shipped them — the sibling clone changed nothing here.
    expect(wf).toContain("types: [website-content-changed]");
    expect(wf).toContain("--surface=memex-website");
    expect(wf).toContain('SRC="https://memex.ai/llms-full.txt"');
    expect(wf).toContain('SRC="https://int.memex.ai/llms-full.txt"');
    expect(wf).toContain("timeout 600");
    // And it knows nothing about the mindset surface.
    expect(wf).not.toContain("mindset");
  });
});

describe("release-sdk per-host destinations (spec-251 t-7 → ac-13)", () => {
  const src = () => read("scripts/release-sdk.mjs");

  it("memex-website stays the DEFAULT target with its original js/ + assets/ layout", () => {
    tagAc(AC13);
    const s = src();
    // Default when --target is absent.
    expect(s).toContain(
      "const targetName = targetArg ? targetArg.slice('--target='.length) : 'memex-website';",
    );
    // The original env var and layout survive.
    expect(s).toContain("MEMEX_WEBSITE_REPO");
    expect(s).toMatch(/resolve\(websiteRepo, 'js'\)/);
    expect(s).toMatch(/f === 'assets' \? resolve\(websiteRepo, 'assets'\)/);
    expect(s).toContain("'js/ assets/'");
  });

  it("the mindset-website target vendors the FULL dist into public/guide/", () => {
    tagAc(AC13);
    const s = src();
    expect(s).toContain("'mindset-website'");
    expect(s).toContain("MINDSET_WEBSITE_REPO");
    expect(s).toMatch(/resolve\(websiteRepo, 'public\/guide'\)/);
    expect(s).toContain("'public/guide/'");
    // The embed contract recorded in provenance points at /guide/.
    expect(s).toContain('src="/guide/memex-guide.js"');
  });

  it("an unknown target is refused, never silently defaulted", () => {
    tagAc(AC13);
    expect(src()).toContain("unknown --target=");
  });
});
