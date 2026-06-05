// spec-168 dec-1/dec-2/dec-3 — scripts/deploy-config.sh resolves the canonical
// per-environment deploy config from a Secret Manager secret (memex-<env>-deploy-env)
// as the always-fetch baseline, honours an explicit opt-in local override, and
// FAILS CLOSED when the secret can't be read.
//
// This exercises the REAL loader: it copies scripts/deploy-config.sh into a temp
// dir and `source`s it under `set -euo pipefail` (the same posture the deploy
// scripts use) with a FAKE `gcloud` on PATH. The fake stands in for Secret
// Manager so the resolution logic is verified end-to-end without any cloud access.
//
// Covers:
//   ac-6:  the loader fetches the secret via `gcloud secrets versions access`.
//   ac-7:  without read access the deploy fails closed with a clear error
//          (the deploy-config.sh half — the PAM-grant half is infra/t-2).
//   ac-8:  with no local deploy.<env>.env present, the loader fetches and
//          proceeds — no "deploy.<env>.env not found" abort.
//   ac-9:  a local file overrides only via explicit opt-in; with the opt-in
//          pointed at the secret it cannot silently take over.
//   ac-10: every instance value (GCP_PROJECT, REGION, hosts, buckets, SERVICE,
//          client ids, MEMEX_OWN_NAMESPACE, HIDDEN_FEATURES, the DB_PASS fetch)
//          resolves from the one canonical config.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, copyFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-168";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "deploy-config.sh");

let TMP: string;
let SCRIPT: string; // copy of deploy-config.sh whose CONFIG_DIR is the temp dir
let FAKE_BIN: string;

// A fake `gcloud`. For the canonical-config fetch it emits a self-contained
// deploy.<env>.env body; the inner DB_PASS fetch line resolves through the same
// fake. FAKE_GCLOUD_MODE switches it to a failing / empty posture.
const FAKE_GCLOUD = `#!/bin/bash
case "\${FAKE_GCLOUD_MODE:-ok}" in
  fail)  echo "PERMISSION_DENIED: secretmanager.versions.access denied (fake)" >&2; exit 1 ;;
  empty) exit 0 ;;
esac
if [[ "$*" == *"--secret=memex-int-deploy-env"* ]]; then
  cat <<'BODY'
GCP_PROJECT="fake-int-project"
REGION="us-fake1"
CLOUD_SQL_INSTANCE_NAME="fake-sql"
DB_NAME="memex"
DB_USER="postgres"
DB_PASS="$(gcloud secrets versions access latest --secret=fake-db-password --project="\${GCP_PROJECT}")"
SERVICE="memex-api"
STATIC_BUCKET="gs://fake-static-bucket"
URL_MAP_NAME="fake-lb"
PUBLIC_HOST="fake.example.com"
API_PUBLIC_HOST="fake.example.com"
GOOGLE_CLIENT_ID="fake-client-id.apps.googleusercontent.com"
EMAIL_FROM="Fake <support@example.com>"
SLACK_CLIENT_ID="fake-slack-id"
MEMEX_OWN_NAMESPACE="fake-ns"
HIDDEN_FEATURES="scaffold,spec-pause,pulse"
BODY
else
  # the inner DB_PASS secret fetch
  echo "fake-db-password-value"
fi
`;

// Run the real loader for ENV=int and return the process result. `localFile`
// optionally seeds a temp deploy.int.env; `env` overrides/augments the process
// env. On success the harness prints a __RESULT__ line we can parse.
function runLoader(opts: {
  env?: Record<string, string>;
  localFile?: string | null;
}): { status: number | null; stdout: string; stderr: string } {
  const localPath = join(TMP, "deploy.int.env");
  if (opts.localFile != null) writeFileSync(localPath, opts.localFile);
  else rmSync(localPath, { force: true });

  const harness = `
set -euo pipefail
source "${SCRIPT}"
echo "__RESULT__ GCP_PROJECT=\${GCP_PROJECT}|REGION=\${REGION}|PUBLIC_HOST=\${PUBLIC_HOST}|SERVICE=\${SERVICE}|STATIC_BUCKET=\${STATIC_BUCKET}|GOOGLE_CLIENT_ID=\${GOOGLE_CLIENT_ID}|MEMEX_OWN_NAMESPACE=\${MEMEX_OWN_NAMESPACE}|HIDDEN_FEATURES=\${HIDDEN_FEATURES:-<unset>}|DB_PASS=\${DB_PASS}"
`;
  const res = spawnSync("bash", ["-c", harness], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      ENV: "int",
      FAKE_GCLOUD_MODE: "ok",
      // Default bootstrap project; individual tests override.
      DEPLOY_CONFIG_PROJECT: "fake-int-project",
      // Don't inherit the caller's source preference.
      DEPLOY_CONFIG_SOURCE: "",
      ...(opts.env ?? {}),
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parseResult(stdout: string): Record<string, string> {
  const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
  if (!line) return {};
  return Object.fromEntries(
    line
      .replace("__RESULT__ ", "")
      .split("|")
      .map((kv) => {
        const i = kv.indexOf("=");
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
  );
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "deploy-config-test-"));
  SCRIPT = join(TMP, "deploy-config.sh");
  copyFileSync(REAL_SCRIPT, SCRIPT); // exercise the real loader bytes
  FAKE_BIN = join(TMP, "bin");
  mkdirSync(FAKE_BIN);
  const fakeGcloud = join(FAKE_BIN, "gcloud");
  writeFileSync(fakeGcloud, FAKE_GCLOUD);
  chmodSync(fakeGcloud, 0o755);
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("spec-168 ac-6 + ac-8: the loader fetches the canonical secret and proceeds with no local file", () => {
  it("fetches memex-int-deploy-env via `gcloud secrets versions access` and resolves config (no 'not found' abort)", () => {
    tagAc(`${SPEC}/acs/ac-6`);
    tagAc(`${SPEC}/acs/ac-8`);
    const { status, stdout, stderr } = runLoader({ localFile: null });
    expect(status).toBe(0);
    expect(stderr).toContain("source=SECRET-MANAGER");
    expect(stderr).toContain("secret=memex-int-deploy-env");
    expect(stdout).not.toContain("not found"); // the old clean-checkout abort is gone
    const r = parseResult(stdout);
    expect(r.GCP_PROJECT).toBe("fake-int-project");
  });
});

describe("spec-168 ac-10: every instance value resolves from the one canonical config", () => {
  it("populates project/region/hosts/bucket/service/client-id/namespace/HIDDEN_FEATURES and the DB_PASS fetch from the secret", () => {
    tagAc(`${SPEC}/acs/ac-10`);
    const { status, stdout } = runLoader({ localFile: null });
    expect(status).toBe(0);
    const r = parseResult(stdout);
    expect(r).toMatchObject({
      GCP_PROJECT: "fake-int-project",
      REGION: "us-fake1",
      PUBLIC_HOST: "fake.example.com",
      SERVICE: "memex-api",
      STATIC_BUCKET: "gs://fake-static-bucket",
      GOOGLE_CLIENT_ID: "fake-client-id.apps.googleusercontent.com",
      MEMEX_OWN_NAMESPACE: "fake-ns",
      HIDDEN_FEATURES: "scaffold,spec-pause,pulse",
    });
    // the DB_PASS *fetch line* in the payload resolved through Secret Manager too
    expect(r.DB_PASS).toBe("fake-db-password-value");
  });
});

describe("spec-168 ac-9: a local file overrides only via explicit opt-in; the secret stays authoritative otherwise", () => {
  const LOCAL = [
    'GCP_PROJECT="LOCAL-project"',
    'REGION="us-local1"',
    'CLOUD_SQL_INSTANCE_NAME="local-sql"',
    'DB_NAME="memex"',
    'DB_USER="postgres"',
    'DB_PASS="local-db-pass"',
    'SERVICE="memex-api"',
    'STATIC_BUCKET="gs://local-bucket"',
    'URL_MAP_NAME="local-lb"',
    'PUBLIC_HOST="local.example.com"',
    'API_PUBLIC_HOST="local.example.com"',
    'GOOGLE_CLIENT_ID="local-client-id.apps.googleusercontent.com"',
    'EMAIL_FROM="Local <support@local.example.com>"',
    'SLACK_CLIENT_ID="local-slack"',
    'MEMEX_OWN_NAMESPACE="local-ns"',
  ].join("\n");

  it("a present local file (no DEPLOY_CONFIG_SOURCE) is an opt-in override and wins, loudly", () => {
    tagAc(`${SPEC}/acs/ac-9`);
    const { status, stdout, stderr } = runLoader({ localFile: LOCAL, env: { DEPLOY_CONFIG_SOURCE: "" } });
    expect(status).toBe(0);
    expect(stderr).toContain("source=LOCAL-OVERRIDE");
    expect(parseResult(stdout).GCP_PROJECT).toBe("LOCAL-project");
  });

  it("DEPLOY_CONFIG_SOURCE=secret makes the canonical secret win even when a local file is present", () => {
    tagAc(`${SPEC}/acs/ac-9`);
    const { status, stdout, stderr } = runLoader({ localFile: LOCAL, env: { DEPLOY_CONFIG_SOURCE: "secret" } });
    expect(status).toBe(0);
    expect(stderr).toContain("source=SECRET-MANAGER");
    // the stray local file did NOT silently take over
    expect(parseResult(stdout).GCP_PROJECT).toBe("fake-int-project");
  });
});

describe("spec-168 ac-7 + ac-8: fail closed — never a silent fallback to stale/empty config", () => {
  it("aborts with a clear error when the secret can't be read (gcloud fails)", () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const { status, stdout, stderr } = runLoader({ localFile: null, env: { FAKE_GCLOUD_MODE: "fail" } });
    expect(status).not.toBe(0); // deploy aborts
    expect(stdout).not.toContain("__RESULT__"); // never reached the resolution / export
    expect(stderr).toContain("fail-closed");
  });

  it("aborts when the secret is empty rather than shipping a blank config", () => {
    tagAc(`${SPEC}/acs/ac-7`);
    const { status, stdout } = runLoader({ localFile: null, env: { FAKE_GCLOUD_MODE: "empty" } });
    expect(status).not.toBe(0);
    expect(stdout).not.toContain("__RESULT__");
  });

  it("aborts when DEPLOY_CONFIG_PROJECT is unset rather than guessing a project (spec-168 dec-5 bootstrap)", () => {
    tagAc(`${SPEC}/acs/ac-8`);
    const { status, stderr } = runLoader({ localFile: null, env: { DEPLOY_CONFIG_PROJECT: "" } });
    expect(status).not.toBe(0);
    expect(stderr).toContain("DEPLOY_CONFIG_PROJECT is not set");
  });
});
