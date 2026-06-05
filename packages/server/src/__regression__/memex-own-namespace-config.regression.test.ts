// b-90 — MEMEX_OWN_NAMESPACE is wired per-env via scripts/deploy-config.sh
// and forwarded to Cloud Run via packages/server/deploy.sh.
//
// Covers:
//   ac-9:  MEMEX_OWN_NAMESPACE is wired per-env. The literal per-env VALUES
//          ('mindset-int' / 'mindset-prod') were externalized into the
//          gitignored scripts/deploy.<env>.env files (pre-public-repo
//          hardening), so they no longer live in any committed file. The
//          committed contract is verified instead: the template declares the
//          key, deploy-config.sh sources the per-env file and exports the var,
//          and the README documents the int→mindset-int / prod→mindset-prod map.
//   ac-10: deploy.sh includes MEMEX_OWN_NAMESPACE in the Cloud Run
//          --update-env-vars block so the deployed service receives it.
//   ac-11: the server reads its own-namespace identity EXCLUSIVELY from
//          process.env.MEMEX_OWN_NAMESPACE — no PUBLIC_HOST inference, no
//          APP_BASE_URL derivation, no host-string-matching.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_CONFIG = join(REPO_ROOT, "scripts", "deploy-config.sh");
const DEPLOY_ENV_EXAMPLE = join(REPO_ROOT, "scripts", "deploy.env.example");
const README = join(REPO_ROOT, "README.md");
const DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const TEST_EVENTS_ROUTE = join(
  REPO_ROOT,
  "packages",
  "server",
  "src",
  "routes",
  "test-events.ts",
);

describe("b-90 ac-9: MEMEX_OWN_NAMESPACE is wired per-env (externalized-config model)", () => {
  const src = readFileSync(DEPLOY_CONFIG, "utf-8");

  it("declares MEMEX_OWN_NAMESPACE in the per-env template (scripts/deploy.env.example)", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-9");
    // The per-env files (scripts/deploy.<env>.env) are gitignored; the template
    // is the committed artifact that tells a deployer the key must be set.
    const example = readFileSync(DEPLOY_ENV_EXAMPLE, "utf-8");
    expect(example).toMatch(/^\s*MEMEX_OWN_NAMESPACE\s*=/m);
  });

  it("sources the per-env file and exports MEMEX_OWN_NAMESPACE so child processes inherit it", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-9");
    // deploy-config.sh sources scripts/deploy.<env>.env (which carries the value)
    // and exports the var so deploy.sh / Cloud Run wiring inherit it.
    expect(src).toMatch(/source\s+"\$\{?ENV_FILE\}?"/);
    expect(src).toMatch(/export\s+MEMEX_OWN_NAMESPACE/);
  });

  it("documents the per-env namespace mapping (int→mindset-int, prod→mindset-prod) in the README", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-9");
    // With the values externalized, the README is the committed record of which
    // namespace each env owns.
    const readme = readFileSync(README, "utf-8");
    expect(readme).toMatch(/`?mindset-int`?\s+in\s+int/);
    expect(readme).toMatch(/`?mindset-prod`?\s+in\s+prod/);
  });
});

describe("b-90 ac-10: deploy.sh wires MEMEX_OWN_NAMESPACE into Cloud Run --update-env-vars", () => {
  it("includes MEMEX_OWN_NAMESPACE=${MEMEX_OWN_NAMESPACE} in the env-vars block", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-10");
    const src = readFileSync(DEPLOY_SH, "utf-8");
    // Format-tolerant match: the variable name + a bash interpolation of
    // itself. The pipe separator (`|`) is the deploy block's delimiter.
    expect(src).toMatch(
      /MEMEX_OWN_NAMESPACE=\$\{MEMEX_OWN_NAMESPACE\}/,
    );
  });

  it("the MEMEX_OWN_NAMESPACE entry sits inside the --update-env-vars argument", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-10");
    const src = readFileSync(DEPLOY_SH, "utf-8");
    // Extract the --update-env-vars line and assert our entry is in it.
    const match = src.match(/--update-env-vars\s+"[^"]*"/);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/MEMEX_OWN_NAMESPACE=\$\{MEMEX_OWN_NAMESPACE\}/);
  });
});

describe("b-90 ac-11: server reads own-namespace EXCLUSIVELY from process.env", () => {
  const src = readFileSync(TEST_EVENTS_ROUTE, "utf-8");

  it("reads MEMEX_OWN_NAMESPACE from process.env", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-11");
    expect(src).toMatch(/process\.env\.MEMEX_OWN_NAMESPACE/);
  });

  it("does NOT derive own-namespace from PUBLIC_HOST", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-11");
    // Guard against a future "simplify" that maps PUBLIC_HOST -> namespace.
    // Allow the string to appear in `//` comments (rule documentation is
    // welcome); flag any code-shaped read like `process.env.PUBLIC_HOST` or
    // direct property access patterns.
    // Strip line comments first so the search only sees code.
    const codeOnly = src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(codeOnly).not.toMatch(/process\.env\.PUBLIC_HOST/);
    expect(codeOnly).not.toMatch(/\bPUBLIC_HOST\b/);
  });

  it("does NOT derive own-namespace from APP_BASE_URL", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-11");
    const codeOnly = src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    expect(codeOnly).not.toMatch(/process\.env\.APP_BASE_URL/);
    expect(codeOnly).not.toMatch(/\bAPP_BASE_URL\b/);
  });

  it("does NOT contain a host→namespace lookup table for inference", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-11");
    // A reverse lookup like { 'int.memex.ai': 'mindset-int', ... } would
    // imply host-derivation; the test-events route uses the namespace map
    // only for forward canonical-URL lookup. Distinguish by the presence
    // of an int.memex.ai key (the inference shape) vs a value (canonical
    // URL shape). The route file has NAMESPACE_TO_BASE_URL where keys are
    // namespace strings; an int.memex.ai key would be the inference shape.
    expect(src).not.toMatch(/['"]int\.memex\.ai['"]\s*:/);
    expect(src).not.toMatch(/['"]memex\.ai['"]\s*:/);
  });
});
