// spec-570 ac-8 (dec-2) — `@memex/shared` and `@memex/extractor` each have their
// own CI job, and neither is path-filtered.
//
// Both packages ran in NO workflow and no git hook until spec-570: 936 tests
// executed only when a developer typed the filter by hand, and the b-67 gate
// inside @memex/shared's suite had never passed in the repository's history.
//
// This guard is the half that survives someone deleting a job "to speed CI up".
// It deliberately asserts the SHAPE of the jobs, not just their presence:
//
//   - TWO jobs, not one combined. dec-2 kept them separate because extractor was
//     green while shared was red, so a combined job would have held extractor's
//     gating hostage to the manifest fix — and because per-package keys give
//     per-package signal at a glance.
//   - NO `paths` / `paths-ignore`. A path-filtered job never reports on the PRs
//     it skips. Once registered as a required status context that leaves every
//     such PR stuck in "Expected — waiting for status", with `enforce_admins`
//     on and therefore no bypass for anyone. It is why `db-schema-drift` is in
//     neither branch-protection list, and why "it is in a workflow" was never
//     the same claim as "it gates".
//   - NO `continue-on-error`, which would turn a red suite into a green check.
//
// The job KEY is the status-context name branch protection registers, so a
// rename here silently unregisters the gate (the spec-390 shard lesson). The
// names are pinned for that reason.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "test.yml");

type Job = {
  steps?: Array<{ run?: string }>;
  paths?: unknown;
  "paths-ignore"?: unknown;
  "continue-on-error"?: unknown;
};

const workflow = load(readFileSync(WORKFLOW, "utf8")) as {
  on?: unknown;
  jobs: Record<string, Job>;
};

// Each package that spec-570 wired, and the filter its job must run.
const WIRED = [
  { job: "shared", filter: "@memex/shared" },
  { job: "extractor", filter: "@memex/extractor" },
] as const;

describe("spec-570: the newly wired packages each have an unfiltered CI job (ac-8)", () => {
  for (const { job, filter } of WIRED) {
    it(`\`${job}\` runs ${filter}'s suite, unfiltered and not soft-failing`, () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-570/acs/ac-8");

      const cfg = workflow.jobs[job];
      expect(
        cfg,
        `.github/workflows/test.yml has no \`${job}\` job. The job key IS the ` +
          `status-context name branch protection registers — renaming or ` +
          `removing it silently unregisters the gate while the checkmarks ` +
          `still look complete [per spec-570 dec-2].`,
      ).toBeDefined();

      const runs = (cfg.steps ?? []).map((s) => s.run ?? "").join("\n");
      expect(
        runs,
        `\`${job}\` must actually run ${filter}'s suite.`,
      ).toContain(`pnpm --filter ${filter} test`);

      expect(
        cfg.paths ?? cfg["paths-ignore"],
        `\`${job}\` must NOT be path-filtered: a job that skips a PR never ` +
          `reports on it, and a required context that never reports wedges ` +
          `that PR permanently (enforce_admins is on, so nobody can override).`,
      ).toBeUndefined();

      expect(
        cfg["continue-on-error"],
        `\`${job}\` must not soft-fail — that turns a red suite into a green check.`,
      ).toBeUndefined();
    });
  }

  it("they are two separate jobs, not one combined (dec-2)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-570/acs/ac-8");
    expect(Object.keys(workflow.jobs)).toEqual(
      expect.arrayContaining(["shared", "extractor"]),
    );
    expect(workflow.jobs.shared).not.toBe(workflow.jobs.extractor);
  });
});
