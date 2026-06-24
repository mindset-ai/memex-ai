// Static-scan drift guard for the spec-172 e2e rebuild (ac-7 + ac-3).
//
// spec-172 tore out the six account-era journeys and the subdomain-routing /
// raw-SQL plumbing they leaned on. The e2e helpers are now thin HTTP clients of
// the env-gated /api/__test__ router; they hold ZERO raw SQL, import NO `postgres`
// driver, and navigate exclusively by PATH-based tenant URLs (std-2 — tenancy is
// path-based on the apex domain, never subdomains).
//
// The two ACs this file proves:
//
//   ac-7 — "...no remaining e2e file references the dropped accounts/
//           account_memberships tables or builds subdomain tenant URLs (the
//           `<sub>.host` tenantUrl form is gone — all tenant navigation is
//           path-based per std-2)."
//   ac-3 — "The e2e seed helpers reference only tables that exist in the live
//           schema, and a guard makes future schema drift in the helpers fail
//           loudly rather than rot silently."
//
// THIS test IS that guard. The unit tests above (the per-file scan over
// packages/ui/e2e) catch the rot empirically; the meta-tests at the bottom prove
// the scanner itself trips on each violation shape (so a future author can't
// reintroduce the rot and have the scan wave it through).
//
// The scanned tree is packages/ui/e2e/**/*.ts — NOT this package's src. It lives
// here in packages/server because the UI package's vitest run only includes
// `src/**/*.test.{ts,tsx}` (its e2e tree is Playwright, run separately and never
// by `vitest run`); the server's vitest config includes `src/**/*.test.ts`, so a
// guard placed here reliably runs in CI's server suite. The reach across packages
// is a deliberate fs walk of ../../../ui/e2e relative to src/__regression__.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const AC = "mindset-prod/memex-building-itself/specs/spec-172/acs";

// packages/server/src/__regression__ -> packages/ui/e2e
const E2E_DIR = join(__dirname, "..", "..", "..", "ui", "e2e");

// ── The three forbidden patterns ───────────────────────────────────────────

// (a) The dropped tables (accounts, account_memberships) in any SQL-ish context:
//     - after a SQL keyword:  FROM accounts / INTO account_memberships / JOIN ... / UPDATE ...
//     - or as a quoted string literal:  'accounts' / "account_memberships"
//   Either spelling means a helper is reaching at a table that no longer exists
//   in the live schema — exactly the silent rot ac-3 forbids.
const DROPPED_TABLE = "(accounts|account_memberships)";
const DROPPED_TABLE_SQL_RE = new RegExp(
  `\\b(FROM|INTO|UPDATE|JOIN|TABLE)\\s+${DROPPED_TABLE}\\b`,
  "i",
);
const DROPPED_TABLE_LITERAL_RE = new RegExp(`['"]${DROPPED_TABLE}['"]`);

// (b) Importing the `postgres` driver — the e2e tier must talk to the server over
//     HTTP via the /api/__test__ router, never open its own DB connection (ac-8).
//     Matches `from "postgres"`, `from 'postgres'`, and `require("postgres")`.
const POSTGRES_IMPORT_RE =
  /(?:from\s*['"]postgres['"]|require\(\s*['"]postgres['"]\s*\))/;

// (c) Subdomain tenant-URL construction. The retired tenantUrl helper did:
//         url.host = `${subdomain}.${url.host}`;
//     Catch BOTH the host reassignment AND the bare `${x}.${...host...}` template
//     that prefixes a subdomain onto a host — std-2 says tenant navigation is
//     path-based, so neither shape should ever return to the e2e tree.
const HOST_REASSIGN_RE = /\.host\s*=/;
const SUBDOMAIN_TEMPLATE_RE = /`\$\{[^`]*\}\.\$\{[^`]*host[^`]*\}/i;

interface Violation {
  rule: "dropped-table" | "postgres-import" | "subdomain-url";
  line: number;
  snippet: string;
}

// Strip // line comments and /* */ block comments so a forbidden token sitting
// in a "...the dropped accounts table is gone..." explanatory comment (like the
// ones in this very file) doesn't trip the scanner. Newlines preserved so line
// numbers stay accurate.
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

// The pure, testable scan: given a file's raw source, return every forbidden
// pattern occurrence (comments stripped first).
export function scanForDrift(rawSource: string): Violation[] {
  const src = stripComments(rawSource);
  const lines = src.split("\n");
  const out: Violation[] = [];

  lines.forEach((text, idx) => {
    const line = idx + 1;
    if (DROPPED_TABLE_SQL_RE.test(text) || DROPPED_TABLE_LITERAL_RE.test(text)) {
      out.push({ rule: "dropped-table", line, snippet: text.trim() });
    }
    if (POSTGRES_IMPORT_RE.test(text)) {
      out.push({ rule: "postgres-import", line, snippet: text.trim() });
    }
    if (HOST_REASSIGN_RE.test(text) || SUBDOMAIN_TEMPLATE_RE.test(text)) {
      out.push({ rule: "subdomain-url", line, snippet: text.trim() });
    }
  });

  return out;
}

function isScannable(path: string): boolean {
  return path.endsWith(".ts") && !path.endsWith(".d.ts");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (isScannable(full)) out.push(full);
  }
  return out;
}

function relKey(abs: string): string {
  return relative(E2E_DIR, abs).split(sep).join("/");
}

describe("spec-172 ac-7 / ac-3: e2e schema-drift guard — packages/ui/e2e", () => {
  it("locates the e2e tree to scan", () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-3`);
    expect(existsSync(E2E_DIR), `expected to find the e2e tree at ${E2E_DIR}`).toBe(true);
    const files = listFiles(E2E_DIR);
    // Sanity: the rebuilt suite (journeys 5,8-19 + tenancy-1..6 + helpers) is here.
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => relKey(f).startsWith("helpers/"))).toBe(true);
  });

  // Drive ALL e2e files through the scan in one assertion so the failure message
  // names every offending file + line at once.
  it("no e2e file references dropped tables, imports postgres, or builds subdomain URLs", () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-3`);

    const offenders: string[] = [];
    for (const file of listFiles(E2E_DIR)) {
      const violations = scanForDrift(readFileSync(file, "utf8"));
      for (const v of violations) {
        offenders.push(`  ${relKey(file)}:${v.line} [${v.rule}] ${v.snippet}`);
      }
    }

    expect(
      offenders,
      "spec-172 drift: the e2e tier must hold zero raw SQL against dropped " +
        "tables, no `postgres` driver import, and no subdomain tenant URLs " +
        "(tenancy is path-based per std-2). Offenders:\n" +
        offenders.join("\n") +
        "\n\nRoute the helper through /api/__test__ (HTTP) and navigate by path.",
    ).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// META-TESTS — prove the scanner trips on each forbidden shape, so the guard
// can't silently stop catching the rot. Run against in-memory fixtures; no
// violating file is ever committed.
// ───────────────────────────────────────────────────────────────────────────
describe("spec-172 ac-7 / ac-3: drift-scanner meta-tests", () => {
  it("flags raw SQL FROM the dropped accounts table", () => {
    tagAc(`${AC}/ac-3`);
    const src = `
      export async function seedAccount(sql, sub) {
        return sql\`SELECT id FROM accounts WHERE subdomain = \${sub} LIMIT 1\`;
      }
    `;
    const v = scanForDrift(src);
    expect(v.some((x) => x.rule === "dropped-table")).toBe(true);
  });

  it("flags INSERT INTO account_memberships", () => {
    tagAc(`${AC}/ac-3`);
    const src = `await sql\`INSERT INTO account_memberships (user_id) VALUES (\${u})\`;`;
    expect(scanForDrift(src).some((x) => x.rule === "dropped-table")).toBe(true);
  });

  it("flags a quoted 'account_memberships' table literal", () => {
    tagAc(`${AC}/ac-3`);
    const src = `const table = "account_memberships";`;
    expect(scanForDrift(src).some((x) => x.rule === "dropped-table")).toBe(true);
  });

  it("flags importing the postgres driver", () => {
    tagAc(`${AC}/ac-7`);
    const fromForm = `import postgres from "postgres";`;
    const requireForm = `const postgres = require("postgres");`;
    expect(scanForDrift(fromForm).some((x) => x.rule === "postgres-import")).toBe(true);
    expect(scanForDrift(requireForm).some((x) => x.rule === "postgres-import")).toBe(true);
  });

  it("flags the retired `url.host = `${sub}.${url.host}`` subdomain form", () => {
    tagAc(`${AC}/ac-7`);
    // The exact shape of the deleted tenantUrl helper.
    const src = "url.host = `${subdomain}.${url.host}`;";
    const v = scanForDrift(src);
    // Both the .host= reassignment AND the subdomain template fire here.
    expect(v.some((x) => x.rule === "subdomain-url")).toBe(true);
  });

  it("flags a bare `${sub}.${host}` subdomain template even without reassignment", () => {
    tagAc(`${AC}/ac-7`);
    const src = "const target = `${sub}.${baseHost}`;";
    expect(scanForDrift(src).some((x) => x.rule === "subdomain-url")).toBe(true);
  });

  it("does NOT flag clean path-based navigation or the live HTTP helpers", () => {
    tagAc(`${AC}/ac-7`);
    tagAc(`${AC}/ac-3`);
    const clean = `
      import { test, expect } from "@playwright/test";
      export async function seedOrg(opts) {
        const res = await fetch(\`\${BASE}/api/__test__/seed-org\`, {
          method: "POST",
          body: JSON.stringify(opts),
        });
        return res.json();
      }
      // navigate by path, never subdomain
      await page.goto(\`/\${namespace}/\${memex}/specs\`);
    `;
    expect(scanForDrift(clean)).toEqual([]);
  });

  it("does NOT flag a forbidden token that lives only inside a comment", () => {
    tagAc(`${AC}/ac-3`);
    const commented = `
      // The legacy helpers targeted the accounts table and url.host = subdomain
      // form; both retired. INSERT INTO account_memberships is gone.
      /* import postgres from "postgres" — removed */
      const ok = true;
    `;
    expect(scanForDrift(commented)).toEqual([]);
  });
});
