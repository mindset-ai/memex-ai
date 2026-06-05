// t-6 of doc-15 — naming-convention sweep for std-1.
// Extended in t-22 of doc-15: MCP schema conformance sweep (argument names +
// descriptions across every registered tool) per F.5 of the doc-15 narrative.
//
// Per std-1, code, schema, MCP, and user-facing copy use namespace/org/memex
// — no `account*` aliases anywhere. This spec asserts on the surfaces that
// matter:
//   - MCP tool registry: no tool name or argument contains 'account'
//   - MCP schema conformance (t-22): every tool's inputSchema and every
//     argument description uses the namespace/org/memex vocabulary — no
//     `account*` / `subdomain*` argument names; no tenancy-concept use of
//     "account" / "subdomain" in any description string
//   - API route inventory: new routes use `/api/orgs`, `/api/me`, etc.
//   - DB schema: tables `accounts` and `account_memberships` are gone
//   - Wire shape: SessionPayload + MembershipSummary use `currentMemexId` /
//     `memexId` / `slug`, never `currentAccountId` / `accountId` / `subdomain`
//   - React UI: `MoveSpecDialog.tsx` carries no lingering `account_id`
//     references (legacy in-line comment removed by t-17)
//
// The only outstanding it.todo is the React UI copy sweep, which renames
// user-facing strings (button labels, page titles, error messages) — owned by
// t-21 of doc-15.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { db } from "../db/connection.js";
import { createMcpServer } from "../mcp/tools.js";
import { toolSpecs } from "../agent/tool-specs.js";

describe("naming-convention [std-1] [t-6]", () => {
  describe("DB schema", () => {
    it("the legacy `accounts` table is gone", async () => {
      const result = await db.execute(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'accounts' AND table_schema = 'public'
        ) AS exists
      `);
      expect((result as unknown as { exists: boolean }[])[0].exists).toBe(false);
    });

    it("the legacy `account_memberships` table is gone", async () => {
      const result = await db.execute(sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = 'account_memberships' AND table_schema = 'public'
        ) AS exists
      `);
      expect((result as unknown as { exists: boolean }[])[0].exists).toBe(false);
    });

    it("the new tables exist (namespaces, orgs, memexes, org_memberships)", async () => {
      const result = await db.execute(sql`
        SELECT count(*)::int AS c FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('namespaces', 'orgs', 'memexes', 'org_memberships')
      `);
      expect((result as unknown as { c: number }[])[0].c).toBe(4);
    });

    it("no tenancy-scoped table has an `account_id` column", async () => {
      // Iterate the columns on every public table — none of these tenancy
      // tables should have account_id anymore (renamed to memex_id or org_id).
      const result = await db.execute(sql`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('account_id', 'personal_account_id', 'referral_share_token_id')
        ORDER BY table_name, column_name
      `);
      const rows = result as unknown as { table_name: string; column_name: string }[];
      expect(rows).toEqual([]);
    });

    it("doc_comments has author_namespace_id (renamed from author_account_id)", async () => {
      const result = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'doc_comments' AND column_name = 'author_namespace_id'
      `);
      expect((result as unknown as { column_name: string }[]).length).toBe(1);
    });
  });

  describe("MCP tool registry", () => {
    // The MCP server is constructed per-request — we instantiate one off-band
    // with a placeholder userId to enumerate the tool catalogue.
    it("no tool name contains the word 'account'", async () => {
      const server = createMcpServer("00000000-0000-0000-0000-000000000000");
      // Reach into the SDK's internal tool registry. Keys are tool names.
      // (The SDK doesn't expose a public list method; we read the private
      // structure here purely for assertion. If the SDK shape changes, update
      // this accessor.)
      const internal = server as unknown as {
        _registeredTools?: Record<string, unknown>;
      };
      const tools = internal._registeredTools ?? {};
      const accountNames = Object.keys(tools).filter((name) =>
        name.toLowerCase().includes("account"),
      );
      expect(accountNames).toEqual([]);
    });

    it("the tool catalogue includes the renamed tools (list_memexes, list_namespaces, ...)", async () => {
      const server = createMcpServer("00000000-0000-0000-0000-000000000000");
      const internal = server as unknown as {
        _registeredTools?: Record<string, unknown>;
      };
      const tools = Object.keys(internal._registeredTools ?? {});
      // list_memexes is the canonical tool the agent calls first per the
      // memex MCP system prompt.
      expect(tools).toContain("list_memexes");
    });
  });

  describe("MCP schema conformance [t-22]", () => {
    // The MCP surface is a contract with LLM agents — argument names and
    // descriptions are LLM-visible and load-bearing for std-1 / F.5 of doc-15.
    // Sweep every registered tool's schema + descriptions for residual
    // tenancy-concept uses of "account" or "subdomain". Allow lexical matches
    // that aren't tenancy ("acceptance criteria", "accept", etc.) via a
    // precise regex tuned to the words in question.

    // Match "account" / "accountId" / "account_id" / "accounts" but NOT
    // "accept" / "acceptance" / "accountability"... by requiring the next
    // character (if any) to not extend the word in a non-tenancy direction.
    // Word-boundary regex: `\baccount(s|Id|_id)?\b`.
    const ACCOUNT_TENANCY_RE = /\baccount(s|Id|_id)?\b/i;
    const SUBDOMAIN_TENANCY_RE = /\bsubdomain[s]?\b/i;

    // Build the set of registered MCP tool entries (spec + the MCP-only
    // `list_memexes`). list_memexes has an empty schema and a description
    // we explicitly assert below.
    const allMcpToolDescriptions: Array<{ name: string; description: string; schema: Record<string, unknown> }> =
      toolSpecs.map((spec) => ({
        name: spec.name,
        description: spec.description,
        schema: spec.schema as unknown as Record<string, unknown>,
      }));

    it("no MCP tool argument name contains `account` or `subdomain`", () => {
      const offenders: string[] = [];
      for (const tool of allMcpToolDescriptions) {
        for (const argName of Object.keys(tool.schema)) {
          if (ACCOUNT_TENANCY_RE.test(argName)) {
            offenders.push(`${tool.name}.${argName} (account*)`);
          }
          if (SUBDOMAIN_TENANCY_RE.test(argName)) {
            offenders.push(`${tool.name}.${argName} (subdomain*)`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("no MCP tool description uses 'account' or 'subdomain' as a tenancy concept", () => {
      const offenders: string[] = [];
      for (const tool of allMcpToolDescriptions) {
        if (ACCOUNT_TENANCY_RE.test(tool.description)) {
          offenders.push(`${tool.name} description: contains tenancy-word "account"`);
        }
        if (SUBDOMAIN_TENANCY_RE.test(tool.description)) {
          offenders.push(`${tool.name} description: contains tenancy-word "subdomain"`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it("no zod .describe() arg description uses 'account' or 'subdomain' as a tenancy concept", () => {
      const offenders: string[] = [];
      for (const tool of allMcpToolDescriptions) {
        for (const [argName, schemaField] of Object.entries(tool.schema)) {
          const desc =
            (schemaField as { description?: string; _def?: { description?: string } })
              .description ??
            (schemaField as { _def?: { description?: string } })._def?.description ??
            "";
          if (typeof desc !== "string" || desc.length === 0) continue;
          if (ACCOUNT_TENANCY_RE.test(desc)) {
            offenders.push(`${tool.name}.${argName}: description contains tenancy-word "account"`);
          }
          if (SUBDOMAIN_TENANCY_RE.test(desc)) {
            offenders.push(`${tool.name}.${argName}: description contains tenancy-word "subdomain"`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("every tool with a `memex` argument describes it in `<namespace>/<memex>` form", () => {
      // F.5: any tool that accepts a `memex` argument expects the slash form.
      // The argument description must surface that vocabulary so the LLM uses
      // the right shape on first call.
      const missing: string[] = [];
      for (const tool of allMcpToolDescriptions) {
        const memexField = tool.schema.memex as
          | { description?: string; _def?: { description?: string } }
          | undefined;
        if (!memexField) continue;
        const desc =
          memexField.description ?? memexField._def?.description ?? "";
        if (!desc.includes("<namespace>/<memex>")) {
          missing.push(`${tool.name}.memex: description missing "<namespace>/<memex>" hint`);
        }
      }
      expect(missing).toEqual([]);
    });

    it("the MCP-only list_memexes tool description uses memex vocabulary", () => {
      // list_memexes is registered inline in mcp/tools.ts (not in toolSpecs),
      // so we read it off the live registry.
      const server = createMcpServer("00000000-0000-0000-0000-000000000000");
      const internal = server as unknown as {
        _registeredTools?: Record<string, { description?: string }>;
      };
      const reg = internal._registeredTools ?? {};
      const desc = reg.list_memexes?.description ?? "";
      expect(desc).not.toMatch(ACCOUNT_TENANCY_RE);
      expect(desc).not.toMatch(SUBDOMAIN_TENANCY_RE);
    });
  });

  describe("API route inventory", () => {
    // We can't enumerate Hono's internal route table directly, but we can
    // assert the new endpoints respond as expected and document the back-
    // compat aliases.
    it("the new endpoints exist", async () => {
      const { app } = await import("../app.js");

      // /api/namespaces/check is reachable (returns JSON for any auth state — 401
      // unauthenticated, 200 with a body when authenticated).
      const checkRes = await app.request("/api/namespaces/check?slug=test", {
        headers: { Host: "memex.ai" },
      });
      expect([200, 401]).toContain(checkRes.status);

      // /api/me is reachable.
      const meRes = await app.request("/api/me", {
        headers: { Host: "memex.ai" },
      });
      expect([200, 401]).toContain(meRes.status);

      // /api/consent/pending is reachable.
      const consentRes = await app.request("/api/consent/pending", {
        headers: { Host: "memex.ai" },
      });
      expect([200, 401]).toContain(consentRes.status);
    });

    it("legacy /api/accounts mount is removed (t-16)", async () => {
      const { app } = await import("../app.js");
      // The /api/accounts prefix should 404 — no router is mounted there.
      // `/api/accounts/check-subdomain` (the most-hit endpoint pre-retirement)
      // returns a 404 because the app has no /api/accounts mount.
      const res = await app.request("/api/accounts/check-subdomain?sub=test", {
        headers: { Host: "memex.ai" },
      });
      expect(res.status).toBe(404);
    });

    it("legacy /api/account mount is removed (t-16)", async () => {
      const { app } = await import("../app.js");
      // The /api/account prefix should 404 — endpoint moved to /api/orgs/current/*.
      const res = await app.request("/api/account", {
        headers: { Host: "memex.ai" },
      });
      expect(res.status).toBe(404);
    });

    it("services/accounts.ts is gone — only services/orgs.ts exists (t-16)", async () => {
      // Importing the deleted file must fail at runtime. We use a dynamic import
      // wrapped in try/catch so the spec itself compiles.
      let importedAccountsModule = false;
      try {
        // @ts-expect-error — the path no longer exists; we're proving that.
        await import("../services/accounts.js");
        importedAccountsModule = true;
      } catch {
        // expected
      }
      expect(importedAccountsModule).toBe(false);

      // The replacement does resolve.
      const orgs = await import("../services/orgs.js");
      expect(typeof orgs.createOrgWithOwner).toBe("function");
      // doc-19 t-1 moved getMemexById to services/memexes.ts.
      const mxModule = await import("../services/memexes.js");
      expect(typeof mxModule.getMemexById).toBe("function");
    });

    it("createAccountWithOwner is no longer exported from services/orgs.ts (t-16)", async () => {
      const orgs = (await import("../services/orgs.js")) as Record<string, unknown>;
      expect(orgs.createAccountWithOwner).toBeUndefined();
      expect(orgs.getAccountById).toBeUndefined();
      expect(orgs.getAccountSummary).toBeUndefined();
      expect(orgs.updateAccountSettings).toBeUndefined();
      expect(orgs.refreshAccountDomainVerifiedFlag).toBeUndefined();
      expect(orgs.findAccountsClaimingDomain).toBeUndefined();
      expect(orgs.isSubdomainAvailable).toBeUndefined();
      expect(orgs.getAccountBySubdomain).toBeUndefined();
    });

    it("tenantMiddleware back-compat alias is removed (t-16)", async () => {
      const resolver = (await import("../middleware/memex-resolver.js")) as Record<string, unknown>;
      expect(resolver.tenantMiddleware).toBeUndefined();
      // The new name is the only one exported.
      expect(typeof resolver.memexResolver).toBe("function");
    });
  });

  describe("Wire-shape conformance [t-17]", () => {
    // Force dev-mode auth so app.request() can hit /api/auth/me without a JWT.
    let originalClientId: string | undefined;
    beforeAll(() => {
      originalClientId = process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      vi.resetModules();
    });

    it("/api/auth/me returns currentMemexId + membership.memexId/slug (never accountId/subdomain)", async () => {
      const { app } = await import("../app.js");
      const res = await app.request("/api/auth/me", {
        headers: { Host: "memex.ai" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Session payload uses the new names.
      expect(body).toHaveProperty("currentMemexId");
      expect(body).not.toHaveProperty("currentAccountId");

      // memberships[] each carry memexId + slug, never accountId / subdomain.
      expect(Array.isArray(body.memberships)).toBe(true);
      for (const m of body.memberships) {
        expect(m).toHaveProperty("memexId");
        expect(m).toHaveProperty("slug");
        expect(m).not.toHaveProperty("accountId");
        expect(m).not.toHaveProperty("subdomain");
      }
    });

    it("MoveSpecDialog.tsx contains no `account_id` references", () => {
      // The dialog used to carry an inline comment referencing `account_id`
      // (the legacy column name). Per t-17 the comment was removed when the
      // memex_id rename landed; this assertion locks that state so a future
      // edit can't reintroduce it.
      const path = resolve(
        process.cwd(),
        "..",
        "ui",
        "src",
        "components",
        "MoveSpecDialog.tsx",
      );
      const contents = readFileSync(path, "utf8");
      expect(contents).not.toMatch(/\baccount_id\b/);
    });

    if (originalClientId !== undefined) {
      process.env.GOOGLE_CLIENT_ID = originalClientId;
    }
  });

  describe("React UI copy sweep [t-21]", () => {
    // Per t-21 of doc-15, user-visible strings in the React UI (and the user-
    // visible email templates) must use the new vocabulary — Memex / Org /
    // Personal / namespace — never "account" or "team" as a tenancy concept.
    //
    // This is a static file walk: we scan every .tsx / .ts file under
    // packages/ui/src/ (excluding tests) plus the server-side email-template
    // file, extract user-facing string contexts (JSX text nodes, JSX string
    // attributes for UI-text props like placeholder/aria-label/title), and
    // flag any word-boundary match for /\baccount(s)?\b/i or /\bteam(s)?\b/i
    // that isn't on the documented allowlist.
    //
    // Identifier-level matches (variable names, types, imports, function calls,
    // routes that aren't user-visible) are out of scope — those were handled by
    // t-16/t-17. Code comments are also out of scope (they don't reach users).

    // Word-boundary regexes for the two tenancy terms. We deliberately match
    // both singular and plural (account/accounts, team/teams). The `i` flag
    // catches PascalCase "Account" / "Team" in JSX text too.
    const ACCOUNT_RE = /\baccount(s)?\b/i;
    const TEAM_RE = /\bteam(s)?\b/i;

    // Allowlist: documented exceptions where the match is *not* user-visible
    // tenancy copy. Each entry is {file, fragment, why}. The match is by
    // substring on a normalized "file:fragment" key — if the user-visible
    // string in that file contains `fragment` we skip it for that file.
    //
    // Keep this list small and load-bearing. Anything truly user-visible
    // should be fixed, not allowlisted.
    interface Allowance {
      file: string; // path relative to repo root (forward slashes)
      fragment: string; // substring of the extracted user-visible text
      why: string;
    }
    const ALLOWLIST: Allowance[] = [
      // doc-19 locked copy refers to "team" in the natural-English sense
      // (a group of people), not the legacy "Team Memex" vocabulary. Both
      // section #2's empty-state + dec-7's personal-variant headline + dec-8's
      // banner are verbatim copy and must not be edited away.
      {
        file: "pages/NamespaceHome.tsx",
        fragment: "Working with a team?",
        why: "dec-7 of doc-19 — locked personal-variant heading.",
      },
      {
        file: "pages/NamespaceHome.tsx",
        fragment: "An Org holds the Memexes your team works in",
        why: "section #2 of doc-19 — locked empty-state copy.",
      },
      {
        file: "pages/NamespaceHome.tsx",
        fragment: "your team's living document",
        why: "section #2 of doc-19 — locked empty-state copy.",
      },
      {
        file: "pages/NamespaceHome.tsx",
        fragment: "Many teams start with a Memex called",
        why: "section #2 of doc-19 — locked empty-state hint.",
      },
      {
        file: "components/CreateOrgBanner.tsx",
        fragment: "Working with a team?",
        why: "dec-8 of doc-19 — locked banner copy.",
      },
      {
        file: "components/CreateOrgForm.tsx",
        fragment: "shared container for your team's Memexes",
        why: "doc-19 build copy — \"team\" is plain English (group of people), not the legacy Team Memex vocabulary.",
      },
    ];

    // Match-extraction: pull out JSX text nodes and the values of string
    // attributes that conventionally hold user-facing text. Code comments and
    // identifier names are deliberately NOT matched.
    function extractUserVisibleStrings(source: string): string[] {
      const out: string[] = [];

      // Strip line comments and block comments so they don't pollute matches.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      // 1. JSX text nodes: anything between > and < that isn't whitespace-only
      //    and isn't itself a JSX tag. This is approximate — a real JSX parser
      //    would be more precise — but it catches the user-visible body copy
      //    we care about (headings, paragraphs, button text, dialog content).
      //
      //    We rule out captures that look like TypeScript code (contain `=` /
      //    `;` / `(` / `)` / `{` / `}`) — those slip in when the source has
      //    something like `<T extends Foo>` adjacent to non-JSX text. False
      //    negatives on JSX text containing parens are acceptable here: the
      //    common case is short user copy.
      const jsxTextRe = />([^<>{}]+)</g;
      let m: RegExpExecArray | null;
      while ((m = jsxTextRe.exec(stripped))) {
        const text = m[1].trim();
        if (text.length === 0) continue;
        // Skip captures that look like code rather than prose.
        if (/[=;()]/.test(text)) continue;
        // Skip captures that look like JSON / dot-paths (no word chars at all).
        if (!/[a-zA-Z]/.test(text)) continue;
        out.push(text);
      }

      // 2. JSX string attributes for known user-text props.
      //    placeholder="..." / aria-label="..." / title="..." / label="..." /
      //    description="..." / helperText="..." / errorText="..." / body="..."
      //    Both single and double quotes; template literals captured separately.
      const stringAttrRe =
        /\b(placeholder|aria-label|title|label|description|helperText|errorText|alt|body|heading|message|tooltip|subtitle|hint)\s*=\s*(["'])((?:(?!\2).)*)\2/g;
      while ((m = stringAttrRe.exec(stripped))) {
        out.push(m[3]);
      }

      // 3. JSX template-literal attributes for the same set of props:
      //    aria-label={`...`} / title={`...`} / body={`...`}.
      const tmplAttrRe =
        /\b(placeholder|aria-label|title|label|description|helperText|errorText|alt|body|heading|message|tooltip|subtitle|hint)\s*=\s*\{`([^`]*)`\}/g;
      while ((m = tmplAttrRe.exec(stripped))) {
        out.push(m[2]);
      }

      return out;
    }

    // Email-template extraction: the file's body is plain TS string literals
    // that ship as email content. Pull every backtick template-literal and
    // every double-quoted string — anything in the file that isn't comments.
    function extractEmailTemplateStrings(source: string): string[] {
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const out: string[] = [];
      // Template literals (multi-line allowed).
      const tmplRe = /`([^`]+)`/g;
      let m: RegExpExecArray | null;
      while ((m = tmplRe.exec(stripped))) out.push(m[1]);
      // Plain double-quoted strings.
      const dq = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
      while ((m = dq.exec(stripped))) out.push(m[1]);
      return out;
    }

    function walkTsxFiles(root: string): string[] {
      const out: string[] = [];
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir)) {
          // Skip test files, node_modules, dist, build output.
          if (
            entry === "node_modules" ||
            entry === "dist" ||
            entry === "build" ||
            entry === ".next"
          ) {
            continue;
          }
          const full = join(dir, entry);
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(full);
          } else if (
            st.isFile() &&
            (entry.endsWith(".tsx") || entry.endsWith(".ts")) &&
            !entry.endsWith(".test.tsx") &&
            !entry.endsWith(".test.ts")
          ) {
            out.push(full);
          }
        }
      }
      return out;
    }

    // Match against allowlist: is this user-visible fragment from this file
    // explicitly approved?
    function isAllowlisted(filePathRel: string, fragment: string): boolean {
      return ALLOWLIST.some(
        (a) =>
          filePathRel.endsWith(a.file) && fragment.includes(a.fragment),
      );
    }

    // The UI source root, relative to packages/server (the test cwd).
    const adminSrcRoot = resolve(
      process.cwd(),
      "..",
      "ui",
      "src",
    );

    // The email-template file is one specific path on the server side.
    const emailTemplatesPath = resolve(
      process.cwd(),
      "src",
      "services",
      "email",
      "templates.ts",
    );

    it("no user-visible 'account' or 'team' in React UI .tsx/.ts files (outside identifiers/comments)", () => {
      const files = walkTsxFiles(adminSrcRoot);
      // Sanity: the walk should pick up at least 50 files. If this drops we
      // probably broke the walker rather than fixed the codebase.
      expect(files.length).toBeGreaterThan(50);

      const offenders: string[] = [];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        const strings = extractUserVisibleStrings(source);
        const relPath = file.slice(adminSrcRoot.length + 1);
        for (const text of strings) {
          if (isAllowlisted(relPath, text)) continue;
          if (ACCOUNT_RE.test(text)) {
            offenders.push(`${relPath}: "${text.slice(0, 80)}" matches /account/`);
          }
          if (TEAM_RE.test(text)) {
            offenders.push(`${relPath}: "${text.slice(0, 80)}" matches /team/`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("no user-visible 'account' or 'team' in server email templates", () => {
      const source = readFileSync(emailTemplatesPath, "utf8");
      const strings = extractEmailTemplateStrings(source);

      const offenders: string[] = [];
      for (const text of strings) {
        if (ACCOUNT_RE.test(text)) {
          offenders.push(`email templates: "${text.slice(0, 80)}" matches /account/`);
        }
        if (TEAM_RE.test(text)) {
          offenders.push(`email templates: "${text.slice(0, 80)}" matches /team/`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("Identifier conformance [drift-sweep]", () => {
    // Post-doc-15 std-1 drift sweep. The t-21 React UI copy sweep above is
    // string-extraction-based (JSX text + user-text attributes) — it only
    // catches user-VISIBLE matches. This block is the identifier-level
    // companion: a small set of files where exported TypeScript identifiers
    // and prose comments / docstrings constitute the std-1 surface even if
    // they never reach a UI string. The three files below were the three
    // surviving drift items at the close of doc-15:
    //
    //  - packages/ui/src/api/client.ts — REST surface for the React UI.
    //    Exported names (function / interface / type / const) are part of the
    //    contract every component imports. Any `Account*` export here is a
    //    std-1 violation regardless of whether a UI string reads it.
    //  - packages/server/src/agent/system-prompt.ts — the LLM-visible system
    //    prompt body. Every English word in here ships to Claude and shapes
    //    model output. Tenancy nouns must use the namespace/org/memex
    //    vocabulary.
    //  - packages/ui/src/utils/{missionInitPrompt,taskInitPrompt}.ts —
    //    the "Spec Coding Agent" clipboard payloads. The text is pasted into
    //    a fresh coding-agent session as the LLM's first user-message; the
    //    same vocabulary rules apply.

    // Re-use the same regex shape as the t-21 user-copy block, but tuned to
    // the identifier surface: we want to match `Account` as a PascalCase
    // identifier prefix, NOT as part of `Accept` / `Acceptance`. Word-boundary
    // + the requirement that the next character (if any) be a letter / digit
    // is sufficient.
    //
    //   `Account`     → match
    //   `AccountFoo`  → match
    //   `Accept`      → no match (the `e` rules out the `\b` after `Account`)
    //   `Acceptance`  → no match
    //
    // The regex `/\bAccount\w*\b/` does exactly this: `\bAccount` matches
    // "Account" at a word boundary, `\w*` consumes a trailing identifier
    // tail, and the final `\b` makes the whole thing a word.
    const IDENT_ACCOUNT_RE = /\bAccount\w*\b/;

    // Allow these PascalCase identifiers in the agent / init prompts: bare
    // English `Account` or `Team` words wouldn't pass the prose check, but a
    // PascalCase token like `Acceptance` shouldn't be a false positive
    // (matched by /\bteam\b/i etc, not /\bAccount\w*\b/). Keep the list
    // narrow and load-bearing.

    it("packages/ui/src/api/client.ts exports no `Account*` identifiers", () => {
      const clientPath = resolve(
        process.cwd(),
        "..",
        "ui",
        "src",
        "api",
        "client.ts",
      );
      const source = readFileSync(clientPath, "utf8");

      // Strip comments and string contents so we only match identifier-shaped
      // tokens in source positions. Comments referencing the legacy name
      // (e.g. "// createAccountApi was removed in the drift sweep") are
      // explicitly OK and shouldn't trigger.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        // Strip the body of single- and double-quoted strings (leave the
        // quotes so the rest of the line parses).
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');

      // Look for exported declarations only — `export function FooAccount(...)`,
      // `export interface AccountFoo`, `export type Account = ...`, etc.
      const exportRe =
        /\bexport\s+(?:async\s+)?(?:function|interface|type|const|class|enum)\s+(\w+)/g;
      const offenders: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = exportRe.exec(stripped))) {
        const name = m[1];
        if (IDENT_ACCOUNT_RE.test(name)) {
          offenders.push(`client.ts exports identifier "${name}"`);
        }
      }

      // Also check re-exports: `export { Foo, Bar } from "..."` and
      // `export { Foo, Bar }`.
      const reExportRe = /\bexport\s*\{([^}]+)\}/g;
      while ((m = reExportRe.exec(stripped))) {
        const names = m[1]
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
          .filter(Boolean);
        for (const name of names) {
          if (IDENT_ACCOUNT_RE.test(name)) {
            offenders.push(`client.ts re-exports identifier "${name}"`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    // Match `team` / `Team` / `account` / `Account` (and plurals) as
    // tenancy nouns in prose. We deliberately re-use the bare word-boundary
    // shape from t-21 since this is checking prose, not identifiers — the
    // PascalCase variant catches "Team" in headings like "Your team reviews".
    const PROSE_TEAM_RE = /\bteam(s)?\b/i;
    const PROSE_ACCOUNT_RE = /\baccount(s|Id|_id)?\b/i;

    // Allowlist of substrings that should not trigger the prose check.
    // Today empty — every match in the three target files has been replaced.
    // If a future edit introduces a legitimate use (e.g. "this is not a
    // team-facing concept" in a code comment), add it here with a one-line
    // rationale.
    const PROSE_ALLOWLIST: string[] = [];

    function checkProseTenancy(filePath: string, label: string): string[] {
      const source = readFileSync(filePath, "utf8");
      const offenders: string[] = [];

      // We sweep the WHOLE file (not just user-visible strings) because both
      // the system prompt and the init-prompt templates ARE the LLM-visible
      // surface — every word in them, including ones embedded in
      // template-literal expressions, is shipped to Claude.
      //
      // The only exclusions are JS/TS code comments (// and /* */) and
      // identifier-shape tokens (variable names, type names, function names).
      // Comments don't reach the LLM; identifiers are scoped by the
      // identifier check above.
      const stripped = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

      // Walk line by line so we can produce a useful offender label.
      const lines = stripped.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip lines that are pure code (no English prose).
        if (!/[a-zA-Z]/.test(line)) continue;

        if (PROSE_ALLOWLIST.some((allowed) => line.includes(allowed))) continue;

        if (PROSE_TEAM_RE.test(line)) {
          offenders.push(`${label}:${i + 1}: "${line.trim().slice(0, 100)}" matches /team/`);
        }
        if (PROSE_ACCOUNT_RE.test(line)) {
          offenders.push(`${label}:${i + 1}: "${line.trim().slice(0, 100)}" matches /account/`);
        }
      }
      return offenders;
    }

    it("packages/server/src/agent/system-prompt.ts uses memex/org vocabulary in prose", () => {
      const path = resolve(process.cwd(), "src", "agent", "system-prompt.ts");
      const offenders = checkProseTenancy(path, "system-prompt.ts");
      expect(offenders).toEqual([]);
    });

    it("packages/ui/src/utils/specInitPrompt.ts uses memex/org vocabulary in prose", () => {
      const path = resolve(
        process.cwd(),
        "..",
        "ui",
        "src",
        "utils",
        "specInitPrompt.ts",
      );
      const offenders = checkProseTenancy(path, "specInitPrompt.ts");
      expect(offenders).toEqual([]);
    });

    it("packages/ui/src/utils/taskInitPrompt.ts uses memex/org vocabulary in prose", () => {
      const path = resolve(
        process.cwd(),
        "..",
        "ui",
        "src",
        "utils",
        "taskInitPrompt.ts",
      );
      const offenders = checkProseTenancy(path, "taskInitPrompt.ts");
      expect(offenders).toEqual([]);
    });
  });
});
