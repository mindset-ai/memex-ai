#!/usr/bin/env node
// spec-243: canary → Slack notifier.
//
// The DECISION (whether this run's outcome warrants a message, and which one)
// is a pure function — `decideNotification` — so it's identical across runners
// and unit-testable. Two callers feed it a normalized `prevStatus`:
//   • GitHub Actions path (this file's main): prevStatus from the previous
//     workflow run's job conclusion via the GitHub API.
//   • Cloud Run path (run-job.mjs): prevStatus from a GCS state object.
//
// Decision table (dec-4: alert on 2 consecutive failures; single blips silent):
//   this run RED   + prev RED/none/unknown → claxon
//   this run RED   + prev GREEN            → silent (the blip allowance)
//   this run GREEN + prev RED              → all-clear
//   this run GREEN + prev GREEN/none       → silent, unless verbose
//
// On the very first run (prev 'none') a red alerts immediately: better one
// early claxon than a silent broken start.

export function failureLines(results) {
  return Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `• *${name}*: ${r.detail}${r.body ? `\n  > ${r.body}` : ""}`)
    .join("\n");
}

function greenList(results) {
  return Object.keys(results)
    .map((name) => `${name} ✓`)
    .join(", ");
}

// prevStatus ∈ 'red' | 'green' | 'none' | 'unknown'
// returns { decision: 'claxon'|'all-clear'|'verbose'|'silent', text: string|null }
export function decideNotification({ summary, prevStatus, host, verbose, runUrl }) {
  const logs = runUrl ? ` <${runUrl}|Run log>` : "";
  if (!summary.ok) {
    const consecutive =
      prevStatus === "red" || prevStatus === "none" || prevStatus === "unknown";
    if (!consecutive) {
      return { decision: "silent", text: null };
    }
    return {
      decision: "claxon",
      text:
        `🚨 *CANARY RED — ${host}* 🚨\n` +
        `${failureLines(summary.results)}\n` +
        `Second consecutive failure (previous: ${prevStatus}).${logs}`,
    };
  }
  if (prevStatus === "red") {
    return {
      decision: "all-clear",
      text: `✅ *All clear — ${host}*: canary is green again.${logs}`,
    };
  }
  if (verbose) {
    return {
      decision: "verbose",
      text: `✅ canary green on ${host}: ${greenList(summary.results)}. _(verbose mode — disable CANARY_VERBOSE to silence)_`,
    };
  }
  return { decision: "silent", text: null };
}

// The status to persist for next time.
export function statusFromSummary(summary) {
  return summary.ok ? "green" : "red";
}

export async function postToSlack(webhook, text) {
  if (!webhook) {
    console.error("[canary-notify] SLACK_WEBHOOK not set — cannot deliver:\n" + text);
    return false;
  }
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error(`[canary-notify] Slack webhook returned ${res.status}`);
    return false;
  }
  console.error("[canary-notify] posted to Slack");
  return true;
}

// ── GitHub Actions path (kept as a manually-dispatchable backup until the
// Cloud Run runner is proven; see dec-1) ────────────────────────────────────

function parseResults(env) {
  try {
    return JSON.parse(process.env.PROBE_RESULTS ?? "");
  } catch {
    return {
      env,
      ok: false,
      results: { probe_step: { ok: false, detail: "probe step produced no results (crashed or cancelled)", body: "" } },
    };
  }
}

// Map the previous GitHub job conclusion to a normalized prevStatus.
async function gitHubPrevStatus(repo, runId, env) {
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };
  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/canary.yml/runs?status=completed&per_page=5`,
      { headers },
    );
    const runs = (await runsRes.json()).workflow_runs ?? [];
    const prev = runs.find((r) => String(r.id) !== String(runId));
    if (!prev) return "none";
    const jobsRes = await fetch(prev.jobs_url, { headers });
    const jobs = (await jobsRes.json()).jobs ?? [];
    const job = jobs.find((j) => j.name.includes(env));
    if (job?.conclusion === "failure") return "red";
    if (job?.conclusion === "success") return "green";
    return "none";
  } catch (err) {
    console.error(`[canary-notify] previous-run lookup failed: ${err}`);
    return "unknown";
  }
}

async function main() {
  const env = process.env.CANARY_ENV ?? "unknown";
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const summary = parseResults(env);
  const prevStatus = await gitHubPrevStatus(repo, runId, env);
  const host = env === "prod" ? "memex.ai" : "int.memex.ai";

  const { decision, text } = decideNotification({
    summary,
    prevStatus,
    host,
    verbose: process.env.CANARY_VERBOSE === "true",
    runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
  });
  console.error(`[canary-notify] decision=${decision} (prev=${prevStatus})`);
  if (text) await postToSlack(process.env.SLACK_WEBHOOK, text);
}

if (process.argv[1] && process.argv[1].endsWith("notify.mjs")) {
  main();
}
