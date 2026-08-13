// spec-168 dec-6 (Option B) — the GitHub Actions CI/CD pipeline is the live deploy
// path, and one canonical per-env config source feeds it. These are static assertions
// on the workflow + repo state (the same shape as the deploy.sh regression tests) —
// they fail if the wiring that makes the scope ACs true is ever removed.
//
// ─────────────────────────────────────────────────────────────────────────────
// MECHANISM SUPERSEDED 2026-08-12 by spec-518 dec-4. The ACs' INTENT is unchanged
// (one canonical source, auto-applied, no per-machine input); what changed is which
// source that is, and these assertions were updated to match.
//
// WAS: deploy.yml injected the environment-scoped `DEPLOY_ENV_FILE` secret and wrote
// it to `scripts/deploy.<env>.env`.
//
// NOW: the canonical source is the Secret Manager secret `memex-<env>-deploy-env`,
// fetched by `scripts/deploy-config.sh` on every deploy and FORCED via
// `DEPLOY_CONFIG_SOURCE: secret` + `DEPLOY_CONFIG_PROJECT`.
//
// Why the old assertions had to change rather than be relaxed: writing
// scripts/deploy.<env>.env made deploy-config.sh take its LOCAL-OVERRIDE branch —
// documented "ad-hoc testing only" — on every CI deploy, so the canonical secret was
// never read in production and prod's scaling silently reverted to deploy.sh's
// defaults. That is spec-518's whole subject. The blob write was retired once BOTH
// environments had deployed clean from the canonical secret (spec-518 ac-17; verified
// in run 31606716124 for int and 31615268013 for prod).
//
// And these tests are themselves a cautionary case. From #589 (2026-08-12 morning),
// `DEPLOY_CONFIG_SOURCE: secret` already forced the canonical source — so ac-1's
// claim that DEPLOY_ENV_FILE was "the ONLY per-env config source" was already FALSE
// while these tests stayed green. They matched a string in a YAML file while the
// runtime obeyed something else: a guard drifting from its subject, which is the
// defect class spec-518 and spec-526 both document. Hence the assertions below now
// pin the FORCED source and the ABSENCE of any local-override write, not a substring.
// ─────────────────────────────────────────────────────────────────────────────
//
// Covers the spec-168 scope/outcome ACs against their real mechanism:
//   ac-1:  one config source → two deployers of the same commit get an identical
//          running config; no per-machine input.
//   ac-3:  changing an env-wide setting = one edit in one place, auto-applied by the
//          next deploy (the pipeline runs on every merge + re-fetches the config).
//   ac-4:  the canonical per-env config is NOT present in the open-core/public repo.
//   ac-5:  deploys need no standing human roles — keyless WIF, no committed key.
//   ac-15: deploy.yml resolves per-env config from the canonical Secret Manager
//          secret, with the source forced so a present local file cannot win.

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

describe("spec-168 ac-15: deploy.yml resolves per-env config from the canonical Secret Manager secret", () => {
  it("forces the canonical source and points at the right project, per env", () => {
    tagAc(`${SPEC}/acs/ac-15`);
    // The source is FORCED, not inferred. Without this, deploy-config.sh's
    // unset-source branch is `[[ -f "$ENV_FILE" ]] && use_local=1` — so any local
    // file present in the checkout would silently win (spec-518 dec-4).
    expect(DEPLOY_YML).toMatch(/DEPLOY_CONFIG_SOURCE:\s*secret/);
    // ...and the bootstrap pointer that cannot live inside the secret it locates
    // (spec-168 dec-5), env-parametric so int and prod share one mechanism.
    expect(DEPLOY_YML).toMatch(/DEPLOY_CONFIG_PROJECT:\s*memex-ai-\$\{\{/);
    expect(DEPLOY_YML).toMatch(/'prod'.*'int'|"prod".*"int"/);
    // and the deploy step runs the same deploy.sh a human would
    expect(DEPLOY_YML).toMatch(/run:\s*bash deploy\.sh/);
  });
});

describe("spec-168 ac-1: a single config source → identical running config for every deployer", () => {
  it("the canonical secret is the ONLY per-env config source — no local-override file is written", () => {
    tagAc(`${SPEC}/acs/ac-1`);
    // The one source, forced.
    expect(DEPLOY_YML).toMatch(/DEPLOY_CONFIG_SOURCE:\s*secret/);

    // THE ASSERTION THAT MATTERS, and the one whose absence allowed spec-518.
    // CI must write NO scripts/deploy.<env>.env. While it did, the forced source
    // above was the only thing standing between the pipeline and the local-override
    // branch — delete that one line and the original defect returns silently, on a
    // green run. No file, no gun.
    expect(DEPLOY_YML).not.toMatch(/scripts\/deploy\.\$?\{?ENV\}?\.env/);
    expect(DEPLOY_YML).not.toMatch(/scripts\/deploy\.(int|prod)\.env/);

    // And the retired blob is gone entirely — no leftover injection to be revived.
    expect(DEPLOY_YML).not.toMatch(/secrets\.DEPLOY_ENV_FILE/);

    // Exactly one config-source DECLARATION (no second, contradicting injection).
    //
    // Anchored to the start of a line, deliberately: an unanchored count also matches
    // the name inside a `#` comment, and deploy.yml quotes `DEPLOY_CONFIG_SOURCE:
    // secret` in the note explaining why the blob was retired. The first draft of this
    // assertion counted 2 and failed on prose — a check must match the thing, not a
    // string that resembles it, which is the same lesson as everything else here.
    const sourceDecls = DEPLOY_YML.match(/^\s*DEPLOY_CONFIG_SOURCE:\s*secret/gm) ?? [];
    expect(sourceDecls.length).toBe(1);
  });
});

describe("spec-168 ac-3: one canonical place to edit, auto-applied by the next deploy", () => {
  it("the pipeline runs automatically on merge and re-fetches the canonical config each run", () => {
    tagAc(`${SPEC}/acs/ac-3`);
    // runs on every merge to develop/main (no manual step to pick up a change)...
    expect(DEPLOY_YML).toMatch(/on:\s*[\s\S]*?push:\s*[\s\S]*?branches:\s*\[develop,\s*main\]/);
    // ...and every run resolves config from the canonical secret, so adding a new
    // secret version is the one edit the next deploy applies. deploy-config.sh
    // fetches it fresh each time (no cached file), which is what makes "one edit,
    // auto-applied" true rather than aspirational.
    expect(DEPLOY_YML).toMatch(/DEPLOY_CONFIG_SOURCE:\s*secret/);
    expect(DEPLOY_YML).toMatch(/DEPLOY_CONFIG_PROJECT:/);
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
