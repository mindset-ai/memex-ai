#!/usr/bin/env node
// spec-243 dec-2 / ac-6: friendly per-env deploy notification to Slack, enriched
// with the specs and PRs that shipped (Option B — clickable spec links, zero API
// calls so a Memex outage can never slow or break a deploy notification).
//
// The spec/PR set is read from the push event's commit list ($GITHUB_EVENT_PATH,
// the full webhook payload every Action run has on disk). For a PR merge that
// list contains every commit the merge introduced, so the tags are all present.
// This reads what the commits *claim* (the memex-app convention tags the spec in
// each subject, e.g. "spec-122: …", "(spec-243)"); a mistagged or untagged commit
// is invisible to it — same trust model as the rest of the convention.
//
// Required env: CANARY_ENV unused; SLACK_WEBHOOK, HOST, OUTCOME (job.status),
// RUN_URL, GITHUB_ACTOR, GITHUB_EVENT_PATH.

import { readFileSync } from "node:fs";

// All memex-app dev specs live in the prod "memex building itself" Memex,
// regardless of which env the code deployed to — so spec links always point
// here. (spec-243 is at exactly this base.)
const SPEC_BASE = "https://memex.ai/mindset-prod/memex-building-itself/specs";

// Extract unique `spec-N` handles from text, sorted numerically. Case-insensitive
// match, canonical lowercase output. (Briefs `b-N` are deliberately not linked —
// their URL path differs and they're effectively absent from current deploys.)
export function extractSpecRefs(text) {
  const seen = new Map();
  for (const m of text.matchAll(/\bspec-(\d+)\b/gi)) {
    const n = Number(m[1]);
    seen.set(n, `spec-${n}`);
  }
  return [...seen.keys()].sort((a, b) => a - b).map((n) => seen.get(n));
}

// Extract unique merged PR numbers from "Merge pull request #N" subjects.
export function extractPrNumbers(text) {
  const seen = new Set();
  for (const m of text.matchAll(/Merge pull request #(\d+)/g)) {
    seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

function specLink(ref) {
  return `<${SPEC_BASE}/${ref}|${ref}>`;
}

export function buildDeployMessage({ host, outcome, actor, runUrl, commits }) {
  const allText = commits.map((c) => c.message ?? "").join("\n");
  const specs = extractSpecRefs(allText);
  const prs = extractPrNumbers(allText);

  const head =
    outcome === "success"
      ? `🚀 *${host}* deployed (by ${actor}). Smoke is green.`
      : `🛑 Deploy to *${host}* did not complete (by ${actor}).`;

  const stats =
    `${commits.length} commit${commits.length === 1 ? "" : "s"}` +
    (prs.length ? `, ${prs.length} PR${prs.length === 1 ? "" : "s"} (${prs.map((n) => `#${n}`).join(", ")})` : "");

  const specsLine = specs.length
    ? `Specs in this release: ${specs.map(specLink).join(", ")}`
    : "_No spec-tagged commits in this release._";

  return `${head}\n${stats}\n${specsLine}\n<${runUrl}|Details>`;
}

function readCommits() {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    return Array.isArray(event.commits) ? event.commits : [];
  } catch {
    return [];
  }
}

async function main() {
  const webhook = process.env.SLACK_WEBHOOK;
  const text = buildDeployMessage({
    host: process.env.HOST ?? "memex",
    outcome: process.env.OUTCOME ?? "success",
    actor: process.env.GITHUB_ACTOR ?? "someone",
    runUrl: process.env.RUN_URL ?? "",
    commits: readCommits(),
  });

  if (!webhook) {
    console.error("[deploy-notify] SLACK_WEBHOOK not set — would have posted:");
    console.error(text);
    return; // never fail a deploy over a missing webhook
  }
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  console.error(`[deploy-notify] Slack returned ${res.status}`);
}

// Only run when invoked directly, so the pure functions above stay importable
// from tests without posting anything.
if (process.argv[1] && process.argv[1].endsWith("deploy-notify.mjs")) {
  main();
}
