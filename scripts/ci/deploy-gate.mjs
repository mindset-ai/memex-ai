#!/usr/bin/env node
// spec-395 (workstream F, dec-1 / dec-2): the deploy GATE.
//
// WHY THIS EXISTS. Before spec-395, .github/workflows/deploy.yml triggered on
// `push` to develop/main with NO dependency on the `test` workflow — so the
// deploy ran CONCURRENTLY with tests, and a non-PR push or a misconfig could ship
// a revision whose tests were red, absent, or still running. This script is the
// fail-closed gate the `deploy` job now `needs:`. It refuses to let the deploy
// start unless the `test` workflow concluded SUCCESS for the EXACT commit SHA.
//
// WHY A GUARD JOB, NOT A `workflow_run` TRIGGER (dec-1). deploy.yml selects int vs
// prod entirely from `github.ref_name` (environment.name, ENV, DEPLOY_CONFIG_PROJECT,
// and the env-scoped SMOKE_* secrets) and its concurrency group keys off `github.ref`. A
// `workflow_run` trigger REWRITES github.ref/ref_name to the default branch
// (develop), which would silently collapse a prod (main) deploy onto INT config +
// secrets. So the trigger stays `push`, the deploy job is untouched, and this gate
// is purely additive — and reviewable in isolation.
//
// DEC-2 — int-smoke-before-prod (WARN MODE). The int post-deploy smoke runs INLINE
// at the int deploy job's tail (deploy.sh → `make smoke-$ENV`, non-zero on
// failure), so a GREEN int `deploy` run for a SHA already MEANS int smoke passed
// for that SHA. A `develop`→`main` release is a MERGE COMMIT (std-21 cl-50:
// GitHub's PR surface cannot fast-forward), so the SHA landing on `main` is a NEW
// commit that never ran on `develop` — querying ITS int deploy would never match
// and would poll to the timeout (the bug this gate originally had). The merge
// commit's 2nd parent IS the `develop` tip the release was built from; that commit
// got the int deploy + smoke and is byte-identical to the merge commit. So for a
// PROD deploy (ref_name === 'main') this gate resolves that develop-side parent and
// queries the int (develop-branch) `deploy` run for IT, recording the result — in
// WARN mode: it reports, it does NOT block. Flipping warn→block is a one-line
// change (set INT_SMOKE_ENFORCE=block) the orchestrator enables AFTER validating
// the live semantics: a break-glass `make deploy` int deploy leaves NO int CI run
// for the SHA (std-26 exception); a hard block would then wedge a legitimately-
// int-smoked prod deploy. The prod-availability blast radius of a false-block is
// why this ships warn-first.
//
// USAGE (in the workflow): `node scripts/ci/deploy-gate.mjs` with env:
//   GH_TOKEN        a token with actions:read (the workflow grants permissions: actions: read)
//   GITHUB_REPOSITORY  owner/repo (provided by Actions)
//   GITHUB_SHA      the commit under deploy (provided by Actions)
//   GITHUB_REF_NAME branch name — 'develop' | 'main' (provided by Actions)
//   GITHUB_API_URL  optional, defaults to https://api.github.com
//   GITHUB_STEP_SUMMARY  optional, the markdown summary file Actions provides
//   TEST_WORKFLOW_FILE   optional, default 'test.yml'
//   DEPLOY_WORKFLOW_FILE optional, default 'deploy.yml'
//   GATE_POLL_TIMEOUT_S  optional, default 900 (15 min) — bounded; fail-closed on expiry
//   GATE_POLL_INTERVAL_S optional, default 15
//   INT_SMOKE_ENFORCE    optional, 'warn' (default) | 'block' — the dec-2 flip
//
// Exit code 0 = deploy may proceed; non-zero = fail closed (deploy never starts).

import { appendFileSync } from "node:fs";

const DEFAULTS = {
  testWorkflowFile: "test.yml",
  deployWorkflowFile: "deploy.yml",
  pollTimeoutS: 900,
  pollIntervalS: 15,
  intSmokeEnforce: "warn",
};

// ── Pure helpers (unit-tested by scripts/ci/deploy-gate.test.mjs) ──────────────

/**
 * Classify a list of workflow runs for a SHA into a gate verdict.
 * Returns one of: 'success' | 'failed' | 'pending' | 'absent'.
 *  - 'absent'  : no run for this workflow+sha exists yet (keep polling, or fail closed on timeout)
 *  - 'pending' : a run exists but has not reached a conclusion (status != 'completed')
 *  - 'success' : the most-recent completed run concluded 'success'
 *  - 'failed'  : the most-recent completed run concluded anything else (failure/cancelled/timed_out/…)
 * "Most recent" = highest run_number, so a re-run supersedes an earlier red.
 */
export function classifyRuns(runs) {
  if (!runs || runs.length === 0) return "absent";
  const completed = runs.filter((r) => r.status === "completed");
  if (completed.length === 0) return "pending";
  const latest = completed.reduce((a, b) =>
    (b.run_number ?? 0) > (a.run_number ?? 0) ? b : a,
  );
  return latest.conclusion === "success" ? "success" : "failed";
}

/** Whether a verdict is terminal (stop polling). 'absent'/'pending' are non-terminal. */
export function isTerminal(verdict) {
  return verdict === "success" || verdict === "failed";
}

/** Build the Actions REST path for a workflow's runs filtered by branch + sha. */
export function runsPath(repo, workflowFile, branch, sha) {
  const qs = new URLSearchParams({ branch, head_sha: sha, per_page: "100" });
  return `/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${qs}`;
}

/**
 * Pick the SHA whose int deploy proves "this build was smoked on int before prod".
 * A develop→main release is a MERGE COMMIT (std-21 cl-50: GitHub can't fast-forward),
 * so the deployed `main` SHA is new and never ran on develop. Its 2nd parent is the
 * develop tip it was built from — byte-identical content, and the SHA that actually
 * received the int deploy + smoke. So for a merge commit, check the 2nd parent; for a
 * commit without one (defensive — a non-merge push to main shouldn't happen per
 * std-21), check the commit itself. For a GitHub merge commit parents = [base(main),
 * head(develop)], so the develop side is parents[1].
 */
export function intCheckSha(deployedSha, parents) {
  return Array.isArray(parents) && parents.length >= 2 ? parents[1] : deployedSha;
}

// ── IO ─────────────────────────────────────────────────────────────────────────

async function fetchRuns({ apiUrl, repo, token, workflowFile, branch, sha }) {
  const url = `${apiUrl}${runsPath(repo, workflowFile, branch, sha)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.workflow_runs ?? [];
}

// Resolve a commit's parent SHAs via the REST commit endpoint. Used to find a
// release merge commit's develop-side parent (parents[1]). Uses the GitHub API
// (not local git) so it works under the gate job's shallow checkout.
async function fetchCommitParents({ apiUrl, repo, token, sha }) {
  const url = `${apiUrl}/repos/${repo}/commits/${encodeURIComponent(sha)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
  }
  const body = await res.json();
  return (body.parents ?? []).map((p) => p.sha);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a workflow's runs for (branch, sha) until the verdict is terminal or the
 * timeout expires. On timeout the last verdict is returned (so 'absent'/'pending'
 * at timeout ⇒ the caller fails closed).
 */
export async function pollVerdict(deps, { workflowFile, branch, sha }) {
  const { fetchRuns: fr, timeoutMs, intervalMs, now = Date.now, log = () => {} } = deps;
  const deadline = now() + timeoutMs;
  // Assigned on the first loop iteration (the loop always runs at least once)
  // before any read; no dead initializer.
  let verdict;
  for (;;) {
    const runs = await fr({ workflowFile, branch, sha });
    verdict = classifyRuns(runs);
    log(`  ${workflowFile} @ ${branch} ${sha.slice(0, 8)} → ${verdict}`);
    if (isTerminal(verdict)) return verdict;
    if (now() >= deadline) return verdict; // bounded — fail closed on a stuck 'absent'/'pending'
    await sleep(intervalMs);
  }
}

// Parse a non-negative-seconds env var, honouring an explicit 0 (Number('0')||def
// would wrongly fall through to the default — 0 is falsy). An unset/blank/invalid
// value uses the default.
function secsToMs(raw, defSecs) {
  if (raw === undefined || raw === null || `${raw}`.trim() === "") return defSecs * 1000;
  const n = Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : defSecs) * 1000;
}

function cfg(env) {
  return {
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    repo: env.GITHUB_REPOSITORY,
    token: env.GH_TOKEN || env.GITHUB_TOKEN,
    sha: env.GITHUB_SHA,
    refName: env.GITHUB_REF_NAME,
    testWorkflowFile: env.TEST_WORKFLOW_FILE || DEFAULTS.testWorkflowFile,
    deployWorkflowFile: env.DEPLOY_WORKFLOW_FILE || DEFAULTS.deployWorkflowFile,
    timeoutMs: secsToMs(env.GATE_POLL_TIMEOUT_S, DEFAULTS.pollTimeoutS),
    intervalMs: secsToMs(env.GATE_POLL_INTERVAL_S, DEFAULTS.pollIntervalS),
    intSmokeEnforce: (env.INT_SMOKE_ENFORCE || DEFAULTS.intSmokeEnforce).toLowerCase(),
  };
}

function summary(c, line) {
  if (c.summaryFile) {
    try {
      appendFileSync(c.summaryFile, line + "\n");
    } catch {
      /* summary is best-effort */
    }
  }
}

export async function runGate(env, { fetchRunsImpl, fetchCommitParentsImpl } = {}) {
  const c = cfg(env);
  c.summaryFile = env.GITHUB_STEP_SUMMARY;
  const log = (m) => process.stdout.write(m + "\n");

  if (!c.repo || !c.sha || !c.refName) {
    log("::error::deploy-gate: missing GITHUB_REPOSITORY / GITHUB_SHA / GITHUB_REF_NAME");
    return 1; // fail closed
  }
  if (!c.token) {
    log("::error::deploy-gate: no GH_TOKEN/GITHUB_TOKEN (need permissions: actions: read)");
    return 1; // fail closed — cannot verify ⇒ do not deploy
  }

  const fr =
    fetchRunsImpl ||
    (({ workflowFile, branch, sha }) =>
      fetchRuns({ apiUrl: c.apiUrl, repo: c.repo, token: c.token, workflowFile, branch, sha }));
  const deps = { fetchRuns: fr, timeoutMs: c.timeoutMs, intervalMs: c.intervalMs, log };
  const fcp =
    fetchCommitParentsImpl ||
    (({ sha }) => fetchCommitParents({ apiUrl: c.apiUrl, repo: c.repo, token: c.token, sha }));

  // ── Gate 1 (dec-1): the `test` workflow must be GREEN for this exact SHA ──
  log(`deploy-gate: checking ${c.testWorkflowFile} for ${c.refName}@${c.sha.slice(0, 8)} …`);
  const testVerdict = await pollVerdict(deps, {
    workflowFile: c.testWorkflowFile,
    branch: c.refName,
    sha: c.sha,
  });
  summary(c, `### Deploy gate (spec-395)\n- **test** for \`${c.sha.slice(0, 8)}\` on \`${c.refName}\`: **${testVerdict}**`);

  if (testVerdict !== "success") {
    log(
      `::error::deploy-gate FAIL CLOSED — test workflow verdict is '${testVerdict}' (need 'success') ` +
        `for ${c.sha}. The deploy will NOT proceed.`,
    );
    return 1;
  }
  log("deploy-gate: ✓ tests green for the SHA.");

  // ── Gate 2 (dec-2): int-smoke-before-prod, WARN mode (prod only) ──
  if (c.refName === "main") {
    // The deployed SHA is the develop→main release MERGE COMMIT (std-21 cl-50:
    // GitHub can't fast-forward), so it never ran on develop and has no int deploy
    // of its own. Resolve its develop-side parent (2nd parent = the develop tip the
    // release was built from), which DID get the int deploy + smoke and is
    // byte-identical, and check THAT. Falls back to the deployed commit on a
    // degenerate shape (no 2nd parent) or if the parents can't be resolved.
    let intSha = c.sha;
    try {
      const parents = await fcp({ sha: c.sha });
      intSha = intCheckSha(c.sha, parents);
      log(
        intSha === c.sha
          ? `deploy-gate: ${c.sha.slice(0, 8)} has no 2nd parent — checking its own int deploy directly.`
          : `deploy-gate: release merge commit ${c.sha.slice(0, 8)} → develop parent ${intSha.slice(0, 8)} (the SHA INT deployed).`,
      );
    } catch (err) {
      log(
        `::warning::deploy-gate: could not resolve parents of ${c.sha.slice(0, 8)} ` +
          `(${err?.message || err}) — checking the deployed commit's int run directly.`,
      );
    }
    log(
      `deploy-gate: prod deploy — checking int (develop) ${c.deployWorkflowFile} run for ${intSha.slice(0, 8)} ` +
        `(a green int deploy run ≡ int smoke passed for that SHA) …`,
    );
    const intVerdict = await pollVerdict(deps, {
      workflowFile: c.deployWorkflowFile,
      branch: "develop",
      sha: intSha,
    });
    const intGreen = intVerdict === "success";
    summary(c, `- **int smoke** (develop deploy run) for \`${intSha.slice(0, 8)}\`: **${intVerdict}** (enforce: \`${c.intSmokeEnforce}\`)`);

    if (!intGreen) {
      const msg =
        `int-smoke-before-prod: int deploy run for ${intSha} is '${intVerdict}', not 'success'. ` +
        `A break-glass int deploy leaves no CI run; verify int smoke was green before promoting.`;
      if (c.intSmokeEnforce === "block") {
        log(`::error::deploy-gate FAIL CLOSED (int-smoke enforce=block) — ${msg}`);
        return 1;
      }
      // WARN mode (default): report loudly, do NOT block.
      log(`::warning::deploy-gate (int-smoke WARN, non-blocking) — ${msg}`);
      log(
        "deploy-gate: int-smoke check is in WARN mode — flip INT_SMOKE_ENFORCE=block to " +
          "make it a hard prod gate once the break-glass/dispatch/timeout semantics are validated.",
      );
    } else {
      log("deploy-gate: ✓ int deploy (smoke) green for the SHA.");
    }
  }

  log("deploy-gate: ✓ gate passed — deploy may proceed.");
  return 0;
}

// CLI entry (skipped when imported by the test).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGate(process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      // Any unexpected error fails CLOSED — never deploy on an unknown gate failure.
      process.stdout.write(`::error::deploy-gate crashed (fail closed): ${err?.stack || err}\n`);
      process.exit(1);
    });
}
