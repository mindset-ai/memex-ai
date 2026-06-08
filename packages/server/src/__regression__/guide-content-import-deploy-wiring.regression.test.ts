// spec-190 t-7 / ac-20, ac-21 — the guide-content import is wired into the CI/CD
// deploy as a bounded, non-gating step, and the freshness enforcement loop's two
// halves (the import validator and the Memex standard) are linked in-repo.
//
// deploy.yml runs the SAME packages/server/deploy.sh a human would, so asserting
// the import is wired into that script proves the "runs on every deploy" contract:
// every INT deploy (push to develop) and every PROD deploy (the develop→main
// promotion) executes it. Mirrored here as a static guard (matching the handhold /
// default-standards backfill guards) so a future edit that drops the hook — or the
// `timeout` bound or the non-gating `||` — fails CI. The runtime
// validate/upsert-by-hash/prune behaviour is covered by
// services/guide-content-import.integration.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { GUIDE_CONTENT_FRESHNESS_STANDARD } from "../services/guide-content-import.js";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SERVER_DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const DEPLOY_WORKFLOW = join(REPO_ROOT, ".github", "workflows", "deploy.yml");
const AC_20 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-20";
const AC_21 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-21";
// Scope ac-10 (deploy half): guide content is re-imported into Postgres on every
// deploy, so the guide's knowledge stays current with the shipped product.
const AC_10 = "mindset-prod/memex-building-itself/specs/spec-190/acs/ac-10";

const deploySh = readFileSync(SERVER_DEPLOY_SH, "utf-8");

// Anchor on the EXECUTABLE migrate line, not a comment, so "import after migrations"
// is genuinely pinned by ordering.
const migrateIdx = deploySh.search(/DATABASE_URL="\$\{DB_URL\}"\s+pnpm db:migrate/);
const importIdx = deploySh.search(/DATABASE_URL="\$\{DB_URL\}"\s+timeout\s+\d+\s+pnpm db:import-guide-content/);
const killProxyIdx = deploySh.search(/kill\s+\$PROXY_PID/);

describe("spec-190 ac-20: the guide-content import is wired into the CI/CD deploy (bounded, non-gating)", () => {
  it("packages/server/deploy.sh invokes the import", () => {
    tagAc(AC_20);
    tagAc(AC_10); // scope: content re-imported into Postgres on every deploy

    expect(importIdx).toBeGreaterThanOrEqual(0);
  });

  it("runs the import AFTER the database migrations (table must exist first)", () => {
    tagAc(AC_20);
    expect(migrateIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(migrateIdx);
  });

  it("runs the import against the proxied DB while the cloud-sql-proxy is still up", () => {
    tagAc(AC_20);
    expect(killProxyIdx).toBeGreaterThan(importIdx);
  });

  it("BOUNDS the import with `timeout` so a hang can never stall the deploy", () => {
    tagAc(AC_20);
    expect(deploySh).toMatch(/timeout\s+\d+\s+pnpm db:import-guide-content/);
  });

  it("invokes the import NON-GATING — a timeout/failure cannot abort the deploy under set -e", () => {
    tagAc(AC_20);
    // Followed by `|| <fallback>`, so a non-zero exit (incl. timeout's 124 and a
    // frontmatter validation failure) is swallowed and the deploy proceeds.
    expect(deploySh).toMatch(/pnpm db:import-guide-content[\s\S]{0,200}\|\|/);
  });

  it("the deploy workflow runs the same deploy.sh, so the wiring actually executes in CI", () => {
    tagAc(AC_20);
    const workflow = readFileSync(DEPLOY_WORKFLOW, "utf-8");
    expect(workflow).toMatch(/bash deploy\.sh/);
  });
});

describe("spec-190 ac-21: a Memex standard requires guide-content updates alongside UI changes", () => {
  // The standard itself is std-29 in mindset-prod/memex-building-itself (created
  // via MCP — the human/agent half of dec-7's enforcement loop). This asserts the
  // in-repo linkage: the import validator (the machine half) names the standard by
  // handle, so an agent reading the code finds the rule it must follow.
  it("the import pipeline cites the freshness standard by a real std-N handle", () => {
    tagAc(AC_21);
    expect(GUIDE_CONTENT_FRESHNESS_STANDARD).toMatch(/^std-\d+$/);
    expect(GUIDE_CONTENT_FRESHNESS_STANDARD).toBe("std-29");
  });
});
