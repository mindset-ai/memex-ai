#!/usr/bin/env node
// spec-243 dec-1 (Cloud Run runner): the Cloud Run Job entrypoint. One execution
// probes BOTH envs over public HTTPS, decides per-env whether to alert (using
// GCS-persisted consecutive-failure state), posts to Slack, and persists the new
// status. Triggered every 10 min by Cloud Scheduler.
//
// Env (wired by the Job; secrets via Secret Manager):
//   CANARY_EMIT_KEY_{PROD,INT}, CANARY_MCP_TOKEN_{PROD,INT}   (secrets)
//   CANARY_AC_UID_{PROD,INT}                                   (config)
//   SLACK_WEBHOOK_{PROD,INT}                                   (secrets)
//   CANARY_STATE_BUCKET                                        (GCS bucket for state)
//   CANARY_VERBOSE = 'true' | unset
//
// Exit code reflects overall health (0 = both envs green) for Cloud Run Job
// execution visibility, but alerting is independent of exit code.

import { runEnvProbes } from "./probe.mjs";
import { decideNotification, statusFromSummary, postToSlack } from "./notify.mjs";
import { readPrevStatus, writeStatus } from "./gcs-state.mjs";

const HOSTS = { prod: "memex.ai", int: "int.memex.ai" };
const WEBHOOK_VAR = { prod: "SLACK_WEBHOOK_PROD", int: "SLACK_WEBHOOK_INT" };

async function handleEnv(env, bucket, verbose) {
  const summary = await runEnvProbes(env);
  const prevStatus = await readPrevStatus(bucket, env);

  const { decision, text } = decideNotification({
    summary,
    prevStatus,
    host: HOSTS[env],
    verbose,
    runUrl: process.env.CANARY_RUN_URL ?? "",
  });
  console.error(`[canary:${env}] decision=${decision} (prev=${prevStatus}, now=${statusFromSummary(summary)})`);

  if (text) await postToSlack(process.env[WEBHOOK_VAR[env]], text);
  // Persist AFTER deciding, so this run's status is what the next run reads.
  await writeStatus(bucket, env, statusFromSummary(summary));
  return summary.ok;
}

async function main() {
  const bucket = process.env.CANARY_STATE_BUCKET;
  const verbose = process.env.CANARY_VERBOSE === "true";
  if (!bucket) {
    console.error("[canary] WARNING: CANARY_STATE_BUCKET unset — consecutive-failure tracking degraded to 'unknown' (will alert on every red).");
  }

  // Probe both envs even if one throws, so a prod problem can't mask int.
  const results = await Promise.allSettled([
    handleEnv("prod", bucket, verbose),
    handleEnv("int", bucket, verbose),
  ]);

  const allOk = results.every((r) => r.status === "fulfilled" && r.value === true);
  process.exit(allOk ? 0 : 1);
}

main();
