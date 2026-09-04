// spec-395 (workstream F, dec-1 / dec-2): the deploy GATE.
//
// Two layers of verification, both runnable in the `test` workflow (so the gate's
// own logic is itself CI-gated):
//   1. STRUCTURAL — deploy.yml actually wires the gate: a `gate` job with
//      permissions: actions: read, the deploy job `needs: gate`, and the trigger /
//      env-selection / concurrency of the deploy job left intact (dec-1).
//   2. BEHAVIOURAL — the pure gate logic in scripts/ci/deploy-gate.mjs:
//      classifyRuns / pollVerdict / runGate fail CLOSED on red/absent/pending tests
//      for the SHA, pass on green, and run the prod int-smoke leg in WARN mode.
//
// NOTE on AC routing: these emit to mindset-prod (the namespace in the ac_uid).
// A dry-run of the live gh-API query against a real recent SHA is done separately,
// out of band (it needs a token + network); this suite pins the logic deterministically.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  classifyRuns,
  isTerminal,
  runsPath,
  pollVerdict,
  intCheckSha,
  runGate,
  // @ts-expect-error — plain .mjs at repo root, no .d.ts; imported for its runtime API.
} from "../../../../scripts/ci/deploy-gate.mjs";

const AC1 = "mindset-prod/memex-building-itself/specs/spec-395/acs/ac-1";
const AC2 = "mindset-prod/memex-building-itself/specs/spec-395/acs/ac-2";
const AC4 = "mindset-prod/memex-building-itself/specs/spec-395/acs/ac-4";
const AC5 = "mindset-prod/memex-building-itself/specs/spec-395/acs/ac-5";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const deployYml = readFileSync(resolve(repoRoot, ".github/workflows/deploy.yml"), "utf8");

// A fetchRuns double the gate can use without network. Returns the canned run list.
function fakeFetch(byKey: Record<string, unknown[]>) {
  return async ({ workflowFile, branch }: { workflowFile: string; branch: string }) =>
    byKey[`${workflowFile}@${branch}`] ?? [];
}

// A sha-AWARE fetchRuns double: keyed by `${workflowFile}@${branch}@${sha}`, so a run
// can exist for one SHA but not another — the merge-commit-vs-develop-parent case.
function fakeFetchBySha(byKey: Record<string, unknown[]>) {
  return async ({
    workflowFile,
    branch,
    sha,
  }: {
    workflowFile: string;
    branch: string;
    sha: string;
  }) => byKey[`${workflowFile}@${branch}@${sha}`] ?? [];
}

// A commit-parents double: maps a SHA to its parents ([base(main), head(develop)] for
// a GitHub merge commit). Unknown SHAs resolve to no parents.
function fakeParents(map: Record<string, string[]>) {
  return async ({ sha }: { sha: string }) => map[sha] ?? [];
}

// Stand-in parent SHAs for a release merge commit: [main-side base, develop-side head].
// DEV_SHA is the develop tip that actually got the int deploy + smoke.
const BASE_SHA = "ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e";
const DEV_SHA = "deve10pdeve10pdeve10pdeve10pdeve10pdeve1";

const fastDeps = (fr: ReturnType<typeof fakeFetch>) => ({
  fetchRuns: fr,
  timeoutMs: 50,
  intervalMs: 5,
  log: () => {},
});

describe("spec-395 deploy gate — structural wiring in deploy.yml (dec-1)", () => {
  it("ac-1/ac-4: deploy.yml has a `gate` job the deploy job needs:, with actions: read", () => {
    tagAc(AC1);
    tagAc(AC4);
    // A `gate` job exists.
    expect(deployYml).toMatch(/^\s{2}gate:/m);
    // The deploy job depends on it (fail-closed: deploy can't start until gate passes).
    expect(deployYml).toMatch(/needs:\s*\[?\s*gate\s*\]?/);
    // The gate runs the gate script.
    expect(deployYml).toContain("scripts/ci/deploy-gate.mjs");
    // Least-privilege: the gate only needs to READ Actions runs.
    expect(deployYml).toMatch(/actions:\s*read/);
  });

  it("ac-1: the deploy job's int/prod env selection + concurrency + WIF auth are LEFT INTACT (dec-1: not a workflow_run trigger)", () => {
    tagAc(AC1);
    // Trigger stays `push` (NOT workflow_run) — preserving ref_name-driven env selection.
    expect(deployYml).toMatch(/on:\s*[\s\S]*push:/);
    expect(deployYml).not.toContain("workflow_run:");
    // ref_name still drives prod-vs-int env + ENV (the dangerous thing workflow_run would break).
    expect(deployYml).toContain("github.ref_name == 'main' && 'prod' || 'int'");
    // concurrency + WIF auth untouched.
    expect(deployYml).toMatch(/concurrency:\s*[\s\S]*group:\s*deploy-/);
    expect(deployYml).toContain("google-github-actions/auth");
  });

  it("ac-2/ac-5: the int-smoke prod leg ships in WARN mode with an explicit warn→block flip point", () => {
    tagAc(AC2);
    tagAc(AC5);
    // The flip knob exists and defaults to warn (dec-2): the deploy.yml passes INT_SMOKE_ENFORCE.
    expect(deployYml).toMatch(/INT_SMOKE_ENFORCE/);
  });
});

describe("spec-395 deploy gate — pure logic (classifyRuns / runsPath / pollVerdict)", () => {
  it("ac-4: classifyRuns maps run sets to the right verdict, newest run wins", () => {
    tagAc(AC4);
    expect(classifyRuns([])).toBe("absent");
    expect(classifyRuns([{ status: "in_progress" }])).toBe("pending");
    expect(classifyRuns([{ status: "queued" }])).toBe("pending");
    expect(
      classifyRuns([{ status: "completed", conclusion: "success", run_number: 1 }]),
    ).toBe("success");
    expect(
      classifyRuns([{ status: "completed", conclusion: "failure", run_number: 1 }]),
    ).toBe("failed");
    // A re-run (higher run_number) supersedes an earlier red.
    expect(
      classifyRuns([
        { status: "completed", conclusion: "failure", run_number: 1 },
        { status: "completed", conclusion: "success", run_number: 2 },
      ]),
    ).toBe("success");
    // …and an earlier green does NOT mask a later red.
    expect(
      classifyRuns([
        { status: "completed", conclusion: "success", run_number: 1 },
        { status: "completed", conclusion: "failure", run_number: 2 },
      ]),
    ).toBe("failed");
  });

  it("ac-4: isTerminal — only success/failed stop the poll; absent/pending keep polling", () => {
    tagAc(AC4);
    expect(isTerminal("success")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("absent")).toBe(false);
    expect(isTerminal("pending")).toBe(false);
  });

  it("ac-4: runsPath scopes the Actions query to the workflow file + branch + head_sha", () => {
    tagAc(AC4);
    const p = runsPath("o/r", "test.yml", "develop", "abc123");
    expect(p).toContain("/repos/o/r/actions/workflows/test.yml/runs");
    expect(p).toContain("branch=develop");
    expect(p).toContain("head_sha=abc123");
  });

  it("ac-4: intCheckSha picks the develop-side parent (2nd parent) for a merge commit, else the commit itself", () => {
    tagAc(AC4);
    // A GitHub merge commit's parents are [base(main), head(develop)] — check the develop side.
    expect(intCheckSha("mergesha", ["basesha", "devsha"])).toBe("devsha");
    // No 2nd parent (non-merge / degenerate) → fall back to the commit itself.
    expect(intCheckSha("solosha", ["basesha"])).toBe("solosha");
    expect(intCheckSha("solosha", [])).toBe("solosha");
    expect(intCheckSha("solosha", undefined)).toBe("solosha");
  });

  it("ac-4: pollVerdict returns the last verdict on timeout (so a stuck 'absent'/'pending' fails closed)", async () => {
    tagAc(AC4);
    // Always absent → bounded poll returns 'absent' (the caller then fails closed).
    const v = await pollVerdict(fastDeps(fakeFetch({})), {
      workflowFile: "test.yml",
      branch: "develop",
      sha: "deadbeef",
    });
    expect(v).toBe("absent");
  });
});

describe("spec-395 deploy gate — runGate end-to-end (fail-closed semantics, dec-1/dec-2)", () => {
  const baseEnv = {
    GITHUB_REPOSITORY: "mindset-ai/memex-ai",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    GH_TOKEN: "x",
    GATE_POLL_TIMEOUT_S: "0", // bounded to one pass for the test
    GATE_POLL_INTERVAL_S: "0",
  };

  it("ac-1/ac-4: GREEN tests for the SHA on develop ⇒ gate passes (exit 0), no GCP touched", async () => {
    tagAc(AC1);
    tagAc(AC4);
    const fr = fakeFetch({
      "test.yml@develop": [{ status: "completed", conclusion: "success", run_number: 7 }],
    });
    const code = await runGate({ ...baseEnv, GITHUB_REF_NAME: "develop" }, { fetchRunsImpl: fr });
    expect(code).toBe(0);
  });

  it("ac-1/ac-4: RED tests for the SHA ⇒ gate fails closed (exit 1)", async () => {
    tagAc(AC1);
    tagAc(AC4);
    const fr = fakeFetch({
      "test.yml@develop": [{ status: "completed", conclusion: "failure", run_number: 7 }],
    });
    const code = await runGate({ ...baseEnv, GITHUB_REF_NAME: "develop" }, { fetchRunsImpl: fr });
    expect(code).toBe(1);
  });

  it("ac-1/ac-4: ABSENT test run for the SHA ⇒ gate fails closed (exit 1) — never deploy unverified", async () => {
    tagAc(AC1);
    tagAc(AC4);
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "develop" },
      { fetchRunsImpl: fakeFetch({}) },
    );
    expect(code).toBe(1);
  });

  it("ac-1: a missing token fails closed (cannot verify ⇒ do not deploy)", async () => {
    tagAc(AC1);
    const code = await runGate(
      { ...baseEnv, GH_TOKEN: "", GITHUB_TOKEN: "", GITHUB_REF_NAME: "develop" },
      { fetchRunsImpl: fakeFetch({ "test.yml@develop": [{ status: "completed", conclusion: "success", run_number: 1 }] }) },
    );
    expect(code).toBe(1);
  });

  it("ac-2/ac-5: PROD with green tests but ABSENT int deploy run ⇒ WARN mode does NOT block (exit 0)", async () => {
    tagAc(AC2);
    tagAc(AC5);
    // tests green for the SHA on main; NO int (develop) deploy run for the SHA.
    const fr = fakeFetch({
      "test.yml@main": [{ status: "completed", conclusion: "success", run_number: 9 }],
      // deploy.yml@develop intentionally absent → int-smoke verdict 'absent'
    });
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "warn" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: fakeParents({ [baseEnv.GITHUB_SHA]: [BASE_SHA, DEV_SHA] }),
      },
    );
    expect(code).toBe(0); // WARN mode: reports, does not block prod.
  });

  it("ac-2/ac-5: PROD int-smoke in BLOCK mode WOULD fail closed on an absent int deploy run (the flip the orchestrator can enable)", async () => {
    tagAc(AC2);
    tagAc(AC5);
    const fr = fakeFetch({
      "test.yml@main": [{ status: "completed", conclusion: "success", run_number: 9 }],
    });
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "block" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: fakeParents({ [baseEnv.GITHUB_SHA]: [BASE_SHA, DEV_SHA] }),
      },
    );
    expect(code).toBe(1);
  });

  it("ac-2/ac-5: PROD with green tests AND green int deploy run ⇒ gate passes (the happy promote path)", async () => {
    tagAc(AC2);
    tagAc(AC5);
    const fr = fakeFetch({
      "test.yml@main": [{ status: "completed", conclusion: "success", run_number: 9 }],
      "deploy.yml@develop": [{ status: "completed", conclusion: "success", run_number: 4 }],
    });
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "block" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: fakeParents({ [baseEnv.GITHUB_SHA]: [BASE_SHA, DEV_SHA] }),
      },
    );
    expect(code).toBe(0);
  });

  it("ac-2/ac-5: PROD release MERGE COMMIT — the gate checks the develop-side PARENT's int deploy, not the merge commit (the 15-min-tax fix)", async () => {
    tagAc(AC2);
    tagAc(AC5);
    // The merge commit landing on main never ran on develop → its OWN int deploy is
    // absent; its 2nd parent (DEV_SHA) is the develop tip that DID get the int deploy.
    const fr = fakeFetchBySha({
      [`test.yml@main@${baseEnv.GITHUB_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 9 },
      ],
      [`deploy.yml@develop@${DEV_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 4 },
      ],
      // deploy.yml@develop@<merge commit> intentionally ABSENT.
    });
    // BLOCK mode makes the distinction load-bearing: checking the merge commit would
    // see 'absent' → exit 1; resolving to the parent sees 'success' → exit 0 (no poll-to-timeout).
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "block" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: fakeParents({ [baseEnv.GITHUB_SHA]: [BASE_SHA, DEV_SHA] }),
      },
    );
    expect(code).toBe(0);
  });

  it("ac-2/ac-5: PROD merge commit whose develop parent has NO int run (break-glass) ⇒ WARN does not block (exit 0)", async () => {
    tagAc(AC2);
    tagAc(AC5);
    const fr = fakeFetchBySha({
      [`test.yml@main@${baseEnv.GITHUB_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 9 },
      ],
      // No int deploy run for the develop parent either (break-glass leaves no CI run).
    });
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "warn" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: fakeParents({ [baseEnv.GITHUB_SHA]: [BASE_SHA, DEV_SHA] }),
      },
    );
    expect(code).toBe(0);
  });

  it("ac-2/ac-5: a main commit with NO 2nd parent falls back to checking its own int deploy", async () => {
    tagAc(AC2);
    tagAc(AC5);
    // Degenerate (non-merge) main commit: intCheckSha returns the commit itself, so
    // the int check keys on baseEnv.GITHUB_SHA directly.
    const fr = fakeFetchBySha({
      [`test.yml@main@${baseEnv.GITHUB_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 9 },
      ],
      [`deploy.yml@develop@${baseEnv.GITHUB_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 4 },
      ],
    });
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "block" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: fakeParents({ [baseEnv.GITHUB_SHA]: [BASE_SHA] }), // single parent
      },
    );
    expect(code).toBe(0);
  });

  it("ac-2/ac-5: when commit-parent resolution THROWS, the gate falls back to the commit (does not crash)", async () => {
    tagAc(AC2);
    tagAc(AC5);
    const fr = fakeFetchBySha({
      [`test.yml@main@${baseEnv.GITHUB_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 9 },
      ],
      [`deploy.yml@develop@${baseEnv.GITHUB_SHA}`]: [
        { status: "completed", conclusion: "success", run_number: 4 },
      ],
    });
    const code = await runGate(
      { ...baseEnv, GITHUB_REF_NAME: "main", INT_SMOKE_ENFORCE: "warn" },
      {
        fetchRunsImpl: fr,
        fetchCommitParentsImpl: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(code).toBe(0);
  });
});

// ── The invariant nobody had written down (spec-395 dec-1, c-2) ───────────────
//
// dec-1 required "a bounded timeout that fails closed". `pollTimeoutS: 900` met that TO
// THE LETTER and was never large enough, because the requirement never put the bound in a
// relationship with the thing it bounds. The gate waits on `test.yml`'s conclusion, and
// `test.yml`'s own `server` shards are each allowed `timeout-minutes: 15` — exactly 900s.
// The gate's entire patience equalled ONE job's allowance, before queueing and before the
// twelve other jobs.
//
// Observed 2026-09-04 on develop@4c11e88d: the gate abandoned at 15m11s with
// `verdict is 'pending'`, and `test` concluded SUCCESS 84 seconds later. The deploy was
// skipped for a run that passed.
//
// A COMMENT IS NOT A GUARD-RAIL, which is why this exists: nothing otherwise stops someone
// raising a `server` shard to `timeout-minutes: 30` without touching the gate, and
// recreating this exactly — where it would again arrive as a red DEPLOY on a SHA that
// looks unverified.
//
// Deliberately UNTAGGED. This is a repository invariant, not a Spec's acceptance
// criterion: spec-395 is `done` with all six of its ACs verified, and minting one there —
// or hanging it off a Spec that does not own the gate — would misfile it. It still gates
// every PR, because it runs in the `server` shards like every other regression test.

describe("deploy gate — its patience must exceed the test workflow's worst-case budget", () => {
  const testYml = readFileSync(resolve(repoRoot, ".github/workflows/test.yml"), "utf8");
  const gateSrc = readFileSync(resolve(repoRoot, "scripts/ci/deploy-gate.mjs"), "utf8");

  const budgetsMin = [...testYml.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map((m) =>
    Number(m[1]),
  );
  const pollTimeoutS = Number(/pollTimeoutS:\s*(\d+)/.exec(gateSrc)?.[1]);

  it("parsed both sides — a pattern that silently matches nothing reports success", () => {
    // THE GUARD ON THE GUARD, and it is today's other lesson: a count can be
    // syntactically right and semantically empty. Twice on 2026-09-04 a grep of mine
    // returned 0 on a tree that had dozens of hits, and both times the only thing that
    // caught it was printing the detail beside the count. A regex that stops matching
    // here would make this whole invariant pass vacuously, forever.
    expect(budgetsMin.length).toBeGreaterThanOrEqual(8); // test.yml has ~12 timeout-minutes
    expect(Math.max(...budgetsMin)).toBeGreaterThanOrEqual(10);
    expect(Number.isFinite(pollTimeoutS)).toBe(true);
    expect(pollTimeoutS).toBeGreaterThan(0);
  });

  it("the gate outlasts the slowest job test.yml is allowed to run", () => {
    const worstCaseS = Math.max(...budgetsMin) * 60;

    // Strictly greater, not >=: at equality the gate can abandon the very run it is
    // waiting for, which is precisely what happened. The message names both numbers
    // because the fix depends on WHICH side moved — a job's allowance was raised, or the
    // gate's patience was lowered.
    expect(
      pollTimeoutS,
      `deploy-gate pollTimeoutS=${pollTimeoutS}s must exceed test.yml's worst-case job ` +
        `budget of ${worstCaseS}s (max timeout-minutes = ${Math.max(...budgetsMin)}). ` +
        `The gate waits on that workflow's CONCLUSION, so a patience at or below a single ` +
        `job's allowance can abandon a run that was going to pass — it did, on ` +
        `develop@4c11e88d, 84 seconds early. Raise pollTimeoutS in scripts/ci/deploy-gate.mjs, ` +
        `or lower the job budget in .github/workflows/test.yml.`,
    ).toBeGreaterThan(worstCaseS);
  });

  it("leaves real headroom, not a single second of it", () => {
    // The whole workflow is a GRAPH, not one job: queueing, checkout, install and the
    // other twelve jobs all sit between the push and the conclusion this gate reads. A
    // bound that merely clears the slowest single job still has no room for the rest.
    const worstCaseS = Math.max(...budgetsMin) * 60;
    expect(pollTimeoutS).toBeGreaterThanOrEqual(worstCaseS * 1.5);
  });
});
