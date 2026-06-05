// spec-168 dec-6 (Option B) — the GitHub Actions CI/CD pipeline is the live deploy
// path, and `.github/workflows/deploy.yml` is the single canonical per-env config
// source: it injects the environment-scoped `DEPLOY_ENV_FILE` secret, authenticates
// keyless via Workload Identity Federation, and no instance config is committed to
// the open-core repo. These are static assertions on the workflow + repo state
// (the same shape as the deploy.sh regression tests) — they fail if the wiring that
// makes the scope ACs true is ever removed.
//
// Covers the spec-168 scope/outcome ACs against their real mechanism:
//   ac-1:  one config source (the DEPLOY_ENV_FILE secret) → two deployers of the
//          same commit get an identical running config; no per-machine input.
//   ac-3:  changing an env-wide setting = one edit to that one secret, auto-applied
//          by the next deploy (the pipeline runs on every merge + re-injects it).
//   ac-4:  the canonical per-env config is NOT present in the open-core/public repo.
//   ac-5:  deploys need no standing human roles — keyless WIF, no committed key.
//   ac-15: deploy.yml resolves per-env config from the DEPLOY_ENV_FILE secret,
//          written to scripts/deploy.<env>.env before the deploy runs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-168";
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_YML = readFileSync(
  join(REPO_ROOT, ".github", "workflows", "deploy.yml"),
  "utf-8",
);
const EXAMPLE = readFileSync(
  join(REPO_ROOT, "scripts", "deploy.env.example"),
  "utf-8",
);

// Run a git command in the repo; return trimmed stdout, or "" on non-zero exit
// (e.g. `git check-ignore` exits 1 when nothing matches).
function git(cmd: string): string {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

describe("spec-168 ac-15: deploy.yml resolves per-env config from the DEPLOY_ENV_FILE secret", () => {
  it("injects secrets.DEPLOY_ENV_FILE and writes it to scripts/deploy.<env>.env before deploying", () => {
    tagAc(`${SPEC}/acs/ac-15`);
    expect(DEPLOY_YML).toMatch(
      /DEPLOY_ENV_FILE:\s*\$\{\{\s*secrets\.DEPLOY_ENV_FILE\s*\}\}/,
    );
    expect(DEPLOY_YML).toMatch(/scripts\/deploy\.\$\{ENV\}\.env/);
    // and the deploy step runs the same deploy.sh a human would
    expect(DEPLOY_YML).toMatch(/run:\s*bash deploy\.sh/);
  });
});

describe("spec-168 ac-1: a single config source → identical running config for every deployer", () => {
  it("the DEPLOY_ENV_FILE secret is the ONLY per-env config source — no per-machine / hardcoded input", () => {
    tagAc(`${SPEC}/acs/ac-1`);
    // the one source...
    expect(DEPLOY_YML).toMatch(/secrets\.DEPLOY_ENV_FILE/);
    // ...applied env-parametrically (scripts/deploy.${ENV}.env), so int and prod
    // share one mechanism and there is no hardcoded per-env file to diverge.
    expect(DEPLOY_YML).not.toMatch(/scripts\/deploy\.(int|prod)\.env/);
    // exactly one secret feeds the deploy config (no second config injection).
    const cfgSecretRefs = DEPLOY_YML.match(/secrets\.DEPLOY_ENV_FILE/g) ?? [];
    expect(cfgSecretRefs.length).toBe(1);
  });
});

describe("spec-168 ac-3: one canonical place to edit, auto-applied by the next deploy", () => {
  it("the pipeline runs automatically on merge and re-injects the secret each run", () => {
    tagAc(`${SPEC}/acs/ac-3`);
    // runs on every merge to develop/main (no manual step to pick up a change)...
    expect(DEPLOY_YML).toMatch(/on:\s*[\s\S]*?push:\s*[\s\S]*?branches:\s*\[develop,\s*main\]/);
    // ...and re-reads the single canonical secret on each run, so a new secret
    // version is the one edit that the next deploy applies.
    expect(DEPLOY_YML).toMatch(/secrets\.DEPLOY_ENV_FILE/);
  });
});

describe("spec-168 ac-5: no standing human roles — keyless Workload Identity Federation", () => {
  it("deploy.yml authenticates via WIF (OIDC), not a committed service-account key", () => {
    tagAc(`${SPEC}/acs/ac-5`);
    expect(DEPLOY_YML).toMatch(/google-github-actions\/auth/);
    expect(DEPLOY_YML).toMatch(/workload_identity_provider:/);
    expect(DEPLOY_YML).toMatch(/service_account:/);
    expect(DEPLOY_YML).toMatch(/id-token:\s*write/); // OIDC token minting
    // no inline/committed credentials
    expect(DEPLOY_YML).not.toMatch(/credentials_json:/);
    expect(DEPLOY_YML).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

describe("spec-168 ac-4: the canonical per-env config is NOT in the open-core / public repo", () => {
  it("scripts/deploy.<env>.env is gitignored and not tracked", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    const ignored = git("git check-ignore scripts/deploy.int.env scripts/deploy.prod.env");
    expect(ignored).toContain("scripts/deploy.int.env");
    expect(ignored).toContain("scripts/deploy.prod.env");
    const tracked = git("git ls-files scripts/deploy.int.env scripts/deploy.prod.env");
    expect(tracked).toBe("");
  });

  it("the tracked template (deploy.env.example) carries placeholders only — no real instance values", () => {
    tagAc(`${SPEC}/acs/ac-4`);
    expect(EXAMPLE).toContain("your-gcp-project"); // value-free placeholder
    // no real Mindset instance values leaked into the open-core repo
    expect(EXAMPLE).not.toMatch(/memex-ai-(int|prod)/); // real project ids
    expect(EXAMPLE).not.toContain("749224423393"); // real prod OAuth client id
    expect(EXAMPLE).not.toContain("1045591124578"); // real int OAuth client id
  });
});
