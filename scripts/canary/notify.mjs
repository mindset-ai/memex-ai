#!/usr/bin/env node
// spec-243: canary → Slack notifier. Runs as the workflow's `if: always()`
// tail step, decides whether THIS run's outcome warrants a message, and posts
// it to the environment's webhook.
//
// Decision table (dec-4: alert on 2 consecutive failures; single blips silent):
//   this run RED   + previous RED    → claxon
//   this run RED   + previous GREEN  → silent (the blip allowance)
//   this run GREEN + previous RED    → all-clear
//   this run GREEN + previous GREEN  → silent, unless CANARY_VERBOSE=true
//
// "Previous" is the same env's job conclusion in the most recent completed
// run of this workflow — fetched via the GitHub API, so the consecutive rule
// needs no state store. When no previous run exists (first ever run), a red
// run alerts immediately: better one early claxon than a silent broken start.
//
// Required env: CANARY_ENV (prod|int), PROBE_RESULTS (JSON from probe.mjs),
// SLACK_WEBHOOK, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID.
// Optional: CANARY_VERBOSE=true.

const env = process.env.CANARY_ENV ?? "unknown";
const webhook = process.env.SLACK_WEBHOOK;
const verbose = process.env.CANARY_VERBOSE === "true";
const repo = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;

function parseResults() {
  try {
    return JSON.parse(process.env.PROBE_RESULTS ?? "");
  } catch {
    // The probe step crashing before it could emit results is itself a red
    // result — report it rather than dying silently.
    return { env, ok: false, results: { probe_step: { ok: false, detail: "probe step produced no results (crashed or cancelled)", body: "" } } };
  }
}

async function previousConclusion() {
  // Most recent COMPLETED run of this workflow before this one, any trigger
  // (schedule or manual) — then the conclusion of this env's job within it.
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
    return job?.conclusion ?? "none";
  } catch (err) {
    console.error(`[canary-notify] previous-run lookup failed: ${err}`);
    return "unknown";
  }
}

function failureLines(results) {
  return Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `• *${name}*: ${r.detail}${r.body ? `\n  > ${r.body}` : ""}`)
    .join("\n");
}

async function post(text) {
  if (!webhook) {
    console.error("[canary-notify] SLACK_WEBHOOK not set — cannot deliver:");
    console.error(text);
    process.exit(1);
  }
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    console.error(`[canary-notify] Slack webhook returned ${res.status}`);
    process.exit(1);
  }
  console.error("[canary-notify] posted to Slack");
}

async function main() {
  const summary = parseResults();
  const prev = await previousConclusion();
  const host = env === "prod" ? "memex.ai" : "int.memex.ai";

  if (!summary.ok) {
    const isConsecutive = prev === "failure" || prev === "none" || prev === "unknown";
    if (!isConsecutive) {
      console.error(`[canary-notify] single failure (previous=${prev}) — staying silent per dec-4`);
      return;
    }
    await post(
      `🚨 *CANARY RED — ${host}* 🚨\n` +
        `${failureLines(summary.results)}\n` +
        `Second consecutive failure (previous run: ${prev}). <${runUrl}|Run log>`,
    );
    return;
  }

  if (prev === "failure") {
    await post(`✅ *All clear — ${host}*: canary is green again. <${runUrl}|Run log>`);
    return;
  }

  if (verbose) {
    const details = Object.entries(summary.results)
      .map(([name, r]) => `${name} ✓`)
      .join(", ");
    await post(`✅ canary green on ${host}: ${details}. _(verbose mode — flip the CANARY_VERBOSE repo variable off to silence these)_`);
  }
}

main();
