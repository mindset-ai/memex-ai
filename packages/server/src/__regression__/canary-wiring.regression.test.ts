// spec-243 — continuous canary: static assertions that the wiring making the
// scope ACs true stays in place (same shape as the cicd-deploy-config and
// deploy.sh regression tests: read the workflow/script files, fail if the
// load-bearing pieces are removed).
//
// These tests verify the WIRING; the live behaviour (probes actually firing
// every 10 minutes, claxons reaching Slack) is observable in the channels and
// the Actions run history, and is verified operationally during rollout via
// the CANARY_VERBOSE success lines.
//
//   ac-1: both envs probed by real authenticated operations on a 10-minute
//         schedule (page + emission + MCP read per env).
//   ac-2: 2-consecutive-failure claxon to the matching env's channel, with
//         all-clear on recovery.
//   ac-3: fate isolation — runs on GitHub-hosted runners, not inside GCP.
//   ac-4: probe writes are hidden:true and carry the canary marker.
//   ac-5: the probe inventory is one readable list in one file.
//   ac-6: every deploy posts a notification to the matching env's channel.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-243";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const CANARY_YML = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "canary.yml"),
  "utf-8",
);
const DEPLOY_YML = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "deploy.yml"),
  "utf-8",
);
const PROBE_MJS = readFileSync(
  join(REPO_ROOT, "scripts", "canary", "probe.mjs"),
  "utf-8",
);
const NOTIFY_MJS = readFileSync(
  join(REPO_ROOT, "scripts", "canary", "notify.mjs"),
  "utf-8",
);

describe("spec-243: canary wiring", () => {
  it("ac-1: canary runs on a 10-minute schedule against both envs", () => {
    tagAc(`${SPEC}/acs/ac-1`);

    expect(CANARY_YML).toContain('cron: "*/10 * * * *"');
    expect(CANARY_YML).toContain("env: [prod, int]");
    expect(CANARY_YML).toContain("node scripts/canary/probe.mjs");
    // Manual trigger stays available for pipe-testing from branches.
    expect(CANARY_YML).toContain("workflow_dispatch");
  });

  it("ac-1: the probes are real authenticated operations, not pings", () => {
    tagAc(`${SPEC}/acs/ac-1`);

    // The emission probe is the exact 2026-06-10 failure path: a real key,
    // a real POST, a 201 demanded.
    expect(PROBE_MJS).toContain("/api/test-events");
    expect(PROBE_MJS).toContain("res.status === 201");
    // The MCP probe drives a real tool call with a real token.
    expect(PROBE_MJS).toContain('method: "tools/call"');
    expect(PROBE_MJS).toContain("Authorization");
    // No /health anywhere — pings are explicitly not probes (s-1).
    expect(PROBE_MJS).not.toContain("/api/health");
  });

  it("ac-1: a missing credential is a failure, never a silent skip", () => {
    tagAc(`${SPEC}/acs/ac-1`);

    // std-17's authed tier self-skipping (describe.skipIf) is part of how the
    // 2026-06-10 outage stayed dark. The canary must hard-fail instead: a
    // missing credential produces an ok:false probe result, and no probe
    // result kind other than ok/failed exists (no "skipped" state at all).
    expect(PROBE_MJS).toContain('ok: false, detail: `missing credential');
    expect(PROBE_MJS).not.toMatch(/status.*skipped|skipped.*probe/i);
  });

  it("ac-2: claxon on 2 consecutive failures, all-clear on recovery, routed per env", () => {
    tagAc(`${SPEC}/acs/ac-2`);

    expect(NOTIFY_MJS).toContain("CANARY RED");
    expect(NOTIFY_MJS).toContain("All clear");
    // The blip allowance: a red run after a green one stays silent.
    expect(NOTIFY_MJS).toContain("staying silent per dec-4");
    // Per-env webhook routing in the workflow.
    expect(CANARY_YML).toContain(
      "matrix.env == 'prod' && secrets.SLACK_WEBHOOK_PROD || secrets.SLACK_WEBHOOK_INT",
    );
    // The notifier always runs, even when the probe step failed.
    expect(CANARY_YML).toContain("if: always()");
  });

  it("ac-3: the canary runs on GitHub-hosted runners, outside GCP", () => {
    tagAc(`${SPEC}/acs/ac-3`);

    expect(CANARY_YML).toContain("runs-on: ubuntu-latest");
    expect(CANARY_YML).not.toContain("self-hosted");
  });

  it("ac-4: canary emissions are hidden and marked as canary traffic", () => {
    tagAc(`${SPEC}/acs/ac-4`);

    expect(PROBE_MJS).toContain("hidden: true");
    expect(PROBE_MJS).toContain("spec-243 canary");
  });

  it("ac-5: the probe inventory is one readable list", () => {
    tagAc(`${SPEC}/acs/ac-5`);

    // Adding a probe = one entry in PROBES + its function. If this list moves
    // or fragments, the "what is monitored" single-place property is gone.
    expect(PROBE_MJS).toContain("const PROBES = [");
    for (const probe of ["page", "emission", "mcp_read"]) {
      expect(PROBE_MJS).toContain(`"${probe}"`);
    }
  });

  it("ac-6: every deploy posts to the matching env's channel", () => {
    tagAc(`${SPEC}/acs/ac-6`);

    expect(DEPLOY_YML).toContain("Notify Slack (deploy)");
    expect(DEPLOY_YML).toContain(
      "env.ENV == 'prod' && secrets.SLACK_WEBHOOK_PROD || secrets.SLACK_WEBHOOK_INT",
    );
    // Friendly on success, short red line on a failed deploy, never skipped.
    expect(DEPLOY_YML).toContain("🚀");
    expect(DEPLOY_YML).toContain("🛑");
  });
});
