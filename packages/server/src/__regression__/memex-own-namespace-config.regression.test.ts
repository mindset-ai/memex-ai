// spec-90 dec-7 (A1) — MEMEX_OWN_NAMESPACE is REMOVED. The cross-namespace
// guard it fed is gone (the per-memex emission-key match is the sole identity
// gate), so the env var has no reader and is stripped from the server source,
// the deploy config, and the docs. These assertions are regression guards: they
// fail if the env var (or a host-derived stand-in) creeps back.
//
// Covers (inverted from the original b-90 Fix-4 commitments):
//   ac-9:  scripts/deploy-config.sh + scripts/deploy.env.example carry no
//          MEMEX_OWN_NAMESPACE.
//   ac-10: packages/server/deploy.sh does not pass it in --update-env-vars.
//   ac-11: no server source reads process.env.MEMEX_OWN_NAMESPACE, and no
//          PUBLIC_HOST / APP_BASE_URL host-derivation is introduced in its place.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_CONFIG = join(REPO_ROOT, "scripts", "deploy-config.sh");
const DEPLOY_ENV_EXAMPLE = join(REPO_ROOT, "scripts", "deploy.env.example");
const DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const TEST_EVENTS_ROUTE = join(
  REPO_ROOT,
  "packages",
  "server",
  "src",
  "routes",
  "test-events.ts",
);

const stripComments = (src: string): string =>
  src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*#.*$/, ""))
    .join("\n");

describe("spec-90 ac-9: MEMEX_OWN_NAMESPACE removed from deploy config", () => {
  it("scripts/deploy-config.sh no longer exports or names MEMEX_OWN_NAMESPACE", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-9");
    const src = readFileSync(DEPLOY_CONFIG, "utf-8");
    expect(src).not.toMatch(/MEMEX_OWN_NAMESPACE/);
  });

  it("scripts/deploy.env.example no longer declares MEMEX_OWN_NAMESPACE", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-9");
    const example = readFileSync(DEPLOY_ENV_EXAMPLE, "utf-8");
    expect(example).not.toMatch(/MEMEX_OWN_NAMESPACE/);
  });
});

describe("spec-90 ac-10: deploy.sh no longer wires MEMEX_OWN_NAMESPACE to Cloud Run", () => {
  it("the --update-env-vars block contains no MEMEX_OWN_NAMESPACE entry", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-10");
    const src = readFileSync(DEPLOY_SH, "utf-8");
    const match = src.match(/--update-env-vars\s+"[^"]*"/);
    expect(match).not.toBeNull();
    expect(match![0]).not.toMatch(/MEMEX_OWN_NAMESPACE/);
  });

  it("deploy.sh does not reference MEMEX_OWN_NAMESPACE anywhere", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-10");
    const src = readFileSync(DEPLOY_SH, "utf-8");
    expect(src).not.toMatch(/MEMEX_OWN_NAMESPACE/);
  });
});

describe("spec-90 ac-11: server no longer reads a server-owned-namespace identity", () => {
  const src = readFileSync(TEST_EVENTS_ROUTE, "utf-8");
  const codeOnly = stripComments(src);

  it("does NOT read process.env.MEMEX_OWN_NAMESPACE", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-11");
    expect(codeOnly).not.toMatch(/process\.env\.MEMEX_OWN_NAMESPACE/);
  });

  it("does NOT reintroduce host-derivation via PUBLIC_HOST or APP_BASE_URL", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-11");
    expect(codeOnly).not.toMatch(/\bPUBLIC_HOST\b/);
    expect(codeOnly).not.toMatch(/\bAPP_BASE_URL\b/);
  });

  it("contains no namespace→host or host→namespace table in the route", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-11");
    // The route no longer needs any namespace/host map at all (B1 moved the
    // single SaaS default into the client helper; the server gates on the key).
    expect(codeOnly).not.toMatch(/NAMESPACE_TO_BASE_URL/);
    expect(codeOnly).not.toMatch(/['"]int\.memex\.ai['"]/);
  });
});
