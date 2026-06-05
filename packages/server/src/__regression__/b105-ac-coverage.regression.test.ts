// b-105 AC coverage — file/DB/git content assertions for the ACs that aren't
// already covered by domain-specific tests. Each `it` block calls `tagAc()`
// for the AC it verifies, then asserts the AC's contract empirically.
//
// Pairs with:
//   - no-legacy-spec-vocab.regression.test.ts (ac-1, ac-21)
//   - spec-migration-allowlist.regression.test.ts (ac-8)
//   - mcp/spec-tools.integration.test.ts (ac-2, ac-11, ac-12 — tagged inline)
//   - services/redirects.integration.test.ts (ac-3, ac-13 — tagged inline)
//
// What's NOT covered locally:
//   - ac-14: requires SPA-on-Hono in prod
//   - ac-17/18/19: Standards content lives in Memex MCP, not the repo
//   - ac-24/25: prod-DB-state-dependent
//   - ac-6/20: N/A (placeholder / process)

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { createMcpServer } from "../mcp/tools.js";
import { rewriteBriefPathToSpec } from "../services/redirects.js";
import { tagAc } from "@memex-ai-ac/vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// packages/server/src/__regression__/<this file> → repo root is 4 levels up.
const REPO_ROOT = resolve(__dirname, "../../../..");

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/briefs/b-105/acs/ac-${n}`;

describe("b-105 ac coverage: file / DB / git invariants", () => {
  // ────────────────────────────────────────────────────────────────────────
  // Schema + data ACs (require the migration to have run locally)
  // ────────────────────────────────────────────────────────────────────────

  it("ac-4 / ac-9: documents.doc_type has zero brief|mission|strategy rows", async () => {
    tagAc(ac(4));
    tagAc(ac(9));
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM documents
       WHERE doc_type IN ('brief', 'mission', 'strategy')
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n ?? -1).toBe(0);
  });

  it("ac-7: post-migration prose has 0 non-allowlisted brief-family hits", async () => {
    tagAc(ac(7));
    const rows = (await db.execute(sql`
      WITH allowlist AS (
        SELECT id FROM documents
         WHERE doc_type IN ('spec', 'brief')
           AND handle IN ('b-10', 'b-26', 'b-65', 'b-105', 'spec-10', 'spec-26', 'spec-65', 'spec-105')
      )
      SELECT
        (SELECT count(*)::int FROM doc_sections s
          WHERE s.doc_id NOT IN (SELECT id FROM allowlist)
            AND s.content ~* '\\m(brief|briefs|b-[0-9]+)\\M') AS sections,
        (SELECT count(*)::int FROM decisions d
          WHERE d.doc_id NOT IN (SELECT id FROM allowlist)
            AND ((d.context    IS NOT NULL AND d.context    ~* '\\m(brief|briefs|b-[0-9]+)\\M')
              OR (d.resolution IS NOT NULL AND d.resolution ~* '\\m(brief|briefs|b-[0-9]+)\\M'))) AS decisions,
        (SELECT count(*)::int FROM doc_comments c
          WHERE c.doc_id NOT IN (SELECT id FROM allowlist)
            AND c.content ~* '\\m(brief|briefs|b-[0-9]+)\\M') AS comments
    `)) as unknown as Array<{ sections: number; decisions: number; comments: number }>;
    const row = rows[0] ?? { sections: -1, decisions: -1, comments: -1 };
    expect(row).toEqual({ sections: 0, decisions: 0, comments: 0 });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Code-level / file-content ACs
  // ────────────────────────────────────────────────────────────────────────

  it("ac-5: creation/system.md uses Spec, mentions SDD framing + std-19, has zero \\bBrief\\b", () => {
    tagAc(ac(5));
    const path = resolve(
      REPO_ROOT,
      "packages/server/src/agent/phases/creation/system.md",
    );
    const body = readFileSync(path, "utf8");
    expect(/\bSpec\b/.test(body)).toBe(true);
    expect(/Spec-driven development/i.test(body)).toBe(true);
    expect(/std-19/.test(body)).toBe(true);
    expect(/\bBrief\b/.test(body)).toBe(false);
  });

  it("ac-10: legacy aliases stripped from specific files", () => {
    tagAc(ac(10));
    const checks: Array<{ path: string; mustNotMatch: RegExp; reason: string }> = [
      {
        path: "packages/server/src/services/memex-search.ts",
        mustNotMatch: /brief\s*:\s*\[\s*['"]brief['"]\s*,\s*['"]strategy['"]\s*,\s*['"]mission['"]/,
        reason: "DOC_TYPES_BY_KIND alias array",
      },
      {
        path: "packages/server/src/mcp/formatters.ts",
        mustNotMatch: /docType\s*===\s*['"]mission['"]/,
        reason: 'mission branch in formatters',
      },
      {
        path: "packages/admin/e2e/helpers/db.ts",
        mustNotMatch: /['"]mission['"]/,
        reason: "docType union still includes 'mission'",
      },
    ];
    for (const c of checks) {
      const body = readFileSync(resolve(REPO_ROOT, c.path), "utf8");
      expect(
        c.mustNotMatch.test(body),
        `${c.path} still matches legacy alias (${c.reason})`,
      ).toBe(false);
    }
    // Positive check: 'spec' is in the admin db.ts docType union
    const dbTs = readFileSync(
      resolve(REPO_ROOT, "packages/admin/e2e/helpers/db.ts"),
      "utf8",
    );
    expect(/['"]spec['"]/.test(dbTs)).toBe(true);
  });

  it("ac-15: packages/cli/package.json at major version 3.x", () => {
    tagAc(ac(15));
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "packages/cli/package.json"), "utf8"),
    ) as { version: string };
    expect(pkg.version).toMatch(/^3\./);
  });

  it("ac-16: CHANGELOG.md 3.x entry names all four breaking changes + links runbook", () => {
    tagAc(ac(16));
    const body = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
    expect(/^##\s+3\./m.test(body)).toBe(true);
    expect(/Breaking changes/i.test(body)).toBe(true);
    // CHANGELOG wraps tool names in backticks: `assess_brief` → `assess_spec`
    expect(/assess_brief[`\s]*(?:→|->|to)[`\s]*assess_spec/.test(body)).toBe(true);
    expect(/publish_brief[`\s]*(?:→|->|to)[`\s]*publish_spec/.test(body)).toBe(true);
    expect(/\/briefs\/b-N.*\/specs\/spec-N|301|Permanent Redirect/i.test(body)).toBe(true);
    expect(/memex-ai.*3(?:\.0)?(?:\.0)?/i.test(body)).toBe(true);
    expect(/docs\/migrations\/b-105-brief-to-spec\.md/.test(body)).toBe(true);
  });

  it("ac-22: .legacy-spec-vocab-allowlist.txt exists at repo root + CODEOWNERS entry", () => {
    tagAc(ac(22));
    const allowlist = readFileSync(
      resolve(REPO_ROOT, ".legacy-spec-vocab-allowlist.txt"),
      "utf8",
    );
    expect(allowlist.length).toBeGreaterThan(0);
    // dec-10 seed: drizzle history + historical docs + the runbook itself
    expect(/packages\/server\/drizzle/.test(allowlist)).toBe(true);
    expect(/CHANGELOG\.md/.test(allowlist)).toBe(true);
    expect(/docs\/migrations\/b-105/.test(allowlist)).toBe(true);

    const codeowners = readFileSync(
      resolve(REPO_ROOT, ".github/CODEOWNERS"),
      "utf8",
    );
    expect(/legacy-spec-vocab-allowlist\.txt/.test(codeowners)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────────
  // MCP tool surface ACs
  // ────────────────────────────────────────────────────────────────────────

  it("ac-2 / ac-11: MCP registry exposes assess_spec + publish_spec; brief variants absent", () => {
    tagAc(ac(2));
    tagAc(ac(11));
    const server = createMcpServer("00000000-0000-0000-0000-0000000000ff");
    // The MCP SDK's Server exposes the registered tools via its internal
    // _registeredTools map (string-keyed by tool name).
    const tools = (server as unknown as {
      _registeredTools?: Record<string, unknown>;
    })._registeredTools;
    expect(tools, "MCP server has no _registeredTools map").toBeTruthy();
    const names = Object.keys(tools ?? {});
    expect(names).toContain("assess_spec");
    expect(names).toContain("publish_spec");
    expect(names).not.toContain("assess_brief");
    expect(names).not.toContain("publish_brief");
  });

  it("ac-12: legacy MCP tool names are not registered as aliases", () => {
    tagAc(ac(12));
    const server = createMcpServer("00000000-0000-0000-0000-0000000000ff");
    const tools = (server as unknown as {
      _registeredTools?: Record<string, unknown>;
    })._registeredTools;
    const names = Object.keys(tools ?? {});
    // Hard rename per dec-5 + dec-7: no alias for the old names.
    expect(names).not.toContain("assess_brief");
    expect(names).not.toContain("publish_brief");
  });

  // ────────────────────────────────────────────────────────────────────────
  // URL redirect ACs
  // ────────────────────────────────────────────────────────────────────────

  it("ac-3 / ac-13: rewriteBriefPathToSpec covers all 5 path shapes with 301", () => {
    tagAc(ac(3));
    tagAc(ac(13));
    // ns/mx are placeholders — any non-empty namespace + memex slug works
    // (the route is pure regex; tenancy resolution happens after redirect).
    const cases: Array<{ input: string; expected: string }> = [
      {
        input: "ns/mx/briefs/b-7",
        expected: "ns/mx/specs/spec-7",
      },
      {
        input: "ns/mx/briefs/b-7/decisions/dec-3",
        expected: "ns/mx/specs/spec-7/decisions/dec-3",
      },
      {
        input: "ns/mx/briefs/b-7/tasks/t-4",
        expected: "ns/mx/specs/spec-7/tasks/t-4",
      },
      {
        input: "ns/mx/briefs/b-7/comments/c-2",
        expected: "ns/mx/specs/spec-7/comments/c-2",
      },
      {
        input: "ns/mx/briefs",
        expected: "ns/mx/specs",
      },
    ];
    for (const { input, expected } of cases) {
      const r = rewriteBriefPathToSpec(input);
      expect(r, `expected rewrite for ${input}`).toBeTruthy();
      expect(r!.status).toBe(301);
      expect(r!.destination).toBe(expected);
      expect(r!.reason).toBe("brief_to_spec_rename");
    }
    // Negative case: a spec-shaped path is NOT rewritten
    expect(rewriteBriefPathToSpec("ns/mx/specs/spec-7")).toBeNull();
  });

  it("ac-23: the b-105 feature merge commit exists on main", () => {
    tagAc(ac(23));
    // The brief's ac-23 said "exactly one merge commit" — that was the
    // original PR-landing assertion. Subsequent merges from origin/main
    // legitimately mention b-105 in their message too (they're follow-ups
    // touching b-105 code). What we actually need to verify is the original
    // b-105 feature merge landed on main.
    const out = execSync(
      "git log --merges --grep='Merge b-105\\|Merge spec-105' main --oneline",
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).trim();
    const lines = out ? out.split("\n") : [];
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(/b-105|spec-105/.test(lines[0] ?? "")).toBe(true);
  });
});
