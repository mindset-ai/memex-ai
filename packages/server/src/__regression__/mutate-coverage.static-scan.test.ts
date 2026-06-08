// Static-scan coverage for std-8 (doc-21 t-4; widened by spec-156 W3 ac-22..ac-24).
//
// The sibling tests (mutate-coverage.service.test.ts, mutate-coverage.endpoint.test.ts,
// mutate-coverage.runtime.test.ts) catch RUNTIME bypasses — they invoke a service
// or endpoint and assert the bus emitted. They miss the case where a new author
// adds a write whose return type is plain `T` (not `Mutated<T>`) and is never
// registered with the runtime test — that path mutates the DB but the type brand
// and the runtime tests both stay quiet.
//
// SCOPE (std-8 §s-3): every DB mutation goes through mutate(), wherever it lives.
// The scan therefore walks all the layers that can issue a raw write —
// services/, routes/, agent/, mcp/, and middleware/ — not just services/.
// (spec-156 ac-22: a seeded raw db write under routes/ must fail the scan.)
//
// For each file it flags any raw `<client>.{insert,update,delete}` call —
// where `<client>` is db | tx | client | conn, the receiver spellings every
// Drizzle write reaches the DB through here (the `.method` may sit on the next
// line of a chained builder) — that isn't lexically inside a `mutate(...)`
// callback.
//
// Heuristic (spec-156 ac-24): a write is "wrapped" only when its offset falls
// inside the balanced-paren argument list of some `mutate(` call. A function with
// one wrapped write followed by a SECOND raw write outside the callback fails —
// "mutate( appears somewhere in the function" is not enough.
//
// Allowlist (spec-156 ac-23): keyed by path RELATIVE TO src/ (e.g.
// "services/oauth/codes.ts"), never bare basename — a future file that merely
// shares a name with an allowlisted one is NOT exempt. Each entry needs a
// one-line justification. If a file shouldn't be on this list — wrap its writes
// in mutate({silent: true}) instead.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// spec-156 W3 acceptance criteria this file proves (meta-tests below).
const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

const SRC_DIR = join(__dirname, "..");

// Layers scanned for raw writes — std-8 §s-3 scope. Every layer that can reach
// the DB client lives here; helper-only dirs (db/, types/) hold no business
// writes and the wrapper itself (services/mutate.ts) is allowlisted below.
const SCAN_DIRS = ["services", "routes", "agent", "mcp", "middleware"] as const;

// Files allowed to contain a raw <client>.{insert,update,delete} (client ∈
// db|tx|client|conn) without a `mutate(` wrap. KEYED BY PATH RELATIVE TO src/
// (posix separators).
// Each entry needs a one-line reason.
const ALLOWLIST: Record<string, string> = {
  "services/mutate.ts":
    "The wrapper itself — the legitimate single call site for all mutations.",
  "routes/__test__.ts":
    "spec-172 test-only e2e seed router — NEVER mounted in production (env-gated in app.ts; pinned by test-router-env-gate.regression.test.ts, ac-9). SEEDING goes through real services (and therefore mutate(), asserted by __test__-router-coverage.integration.test.ts ac-8); the raw writes here are journey CLEANUP cascades (deleting throwaway orgs/namespaces/docs — emitting teardown events would spam the SSE bus the journeys are asserting) plus two seed nudges (decision options backfill, org-membership grant) with no SSE subscriber interest.",
  // spec-161 clause service — regenerateSectionContentTx is a tx-helper invoked
  // ONLY from inside the mutate() callbacks of the clause writers (createClause /
  // updateClause / deleteClause / addClausesToSection / decomposeSection — all
  // return Mutated<T> and dual-emit clause + section keys). The callback-scoped
  // heuristic (ac-24) cannot follow the helper indirection; the service-coverage
  // brand test still polices every public entry point of this file.
  "services/clauses.ts":
    "tx-helper indirection — regenerateSectionContentTx writes doc_sections.content only inside callers' mutate() callbacks; all public writers return Mutated<T> (verified by mutate-coverage.service).",
  // spec-179 clause_refs maintenance — syncClauseRefsTx is a tx-helper invoked
  // ONLY from inside the mutate() callbacks of the clause writers in clauses.ts
  // (same indirection as regenerateSectionContentTx above). clause_refs is a
  // derived materialization of clause bodies with no bus entity of its own —
  // the clause + section events the callers already emit ARE its change signal.
  "services/clause-refs.ts":
    "tx-helper indirection (spec-179) — syncClauseRefsTx writes clause_refs only inside the clause writers' mutate() callbacks (clauses.ts); clause_refs is a derived projection whose change signal is the callers' clause/section events.",
  // spec-162 test_event_latest summary maintenance — applyEmissionToSummary /
  // removeSummaryForPair take a `conn: Db` and write the derived summary ONLY
  // inside the mutate() callbacks of their two callers (routes/test-events.ts
  // emission insert; services/acs.ts discontinueTestEventsForAc). The
  // callback-scoped heuristic (ac-24) can't follow the helper indirection; both
  // public write paths return through mutate() (policed by the runtime/endpoint
  // coverage tests). test_event_latest is a derived rollup of the test_events
  // log with no bus entity of its own.
  "services/test-event-latest.ts":
    "tx-helper indirection (spec-162) — applyEmissionToSummary / removeSummaryForPair write test_event_latest only inside callers' mutate() callbacks (routes/test-events.ts, services/acs.ts discontinueTestEventsForAc); both public write paths return through mutate().",
  // spec-177 issue-1 — findOrCreatePersonalMemex is a tx-helper invoked ONLY from
  // inside ensureUserNamespace's mutate() callbacks (both the ownership-repair
  // branch and the create branch). It race-safely find-or-creates the "personal"
  // memex (ON CONFLICT + re-read). The callback-scoped heuristic (ac-24) cannot
  // follow the helper indirection; ensureUserNamespace itself returns Mutated<T>
  // and emits the user_namespace/memex keys.
  "services/user-namespaces.ts":
    "tx-helper indirection (spec-177 issue-1) — findOrCreatePersonalMemex inserts memexes only inside ensureUserNamespace's mutate() callbacks; the public writer returns Mutated<T> with user_namespace + memex emissions.",
  // spec-150 standards decomposition — develop-side entry ported to the
  // path-keyed scheme during the spec-156 rebase.
  "services/standards-migration.ts":
    "spec-150 bulk standards-decomposition migration. Operator-run one-time backfill (the decompose-standards script + backup/validate/restore), not a live in-session mutation — emitting per-clause SSE events for ~1272 rows would be noise, and the snapshot tables are raw DDL. The INTERACTIVE clause writes (clauses.ts createClause/updateClause/deleteClause/addClausesToSection) DO go through mutate(); this file is the migration path only.",
  // OAuth services (clients.ts, codes.ts, refresh-tokens.ts) were de-allowlisted by
  // spec-156 ac-18 — every write now flows through mutate({silent:true}) with the
  // oauth_client / oauth_code / oauth_refresh_token bus entities (silent-allowed per
  // std-8 §6), matching the mcp_token pattern in services/mcp-tokens.ts. The scanner
  // now verifies them like any other service.
  "services/mcp-telemetry.ts":
    "MCP tool-call telemetry (mcp_sessions, mcp_tool_calls). Cross-tenant observability rows — no memex_id, no bus entity, no SSE fan-out. The bus is keyed on memexId for tenant fan-out; telemetry rows have no tenancy by design (they record cross-Memex MCP traffic).",
  "routes/backstage.ts":
    "Dev-mode-only org_membership grant (DEV_USER_EMAIL admin self-grant). org_membership is an access-control bootstrap row — no memex_id, no bus entity, not Memex-scoped tenant content; nothing subscribes to it over SSE.",
  "middleware/session.ts":
    "Dev-user fallback self-heals org_membership for DEV_ORG_NAMESPACES (ensureDevMemberships). Same non-tenancy-scoped access-control bootstrap as routes/backstage.ts — org_membership has no memex_id / bus entity.",
  // ── Non-tenancy-scoped identity / auth / allocation tables ──────────────
  // These write rows that carry NO memex_id and have NO bus entity — the bus is
  // keyed on memexId for per-tenant SSE fan-out, so there's nothing to emit and
  // no subscriber to wake. Same category as services/mcp-telemetry.ts above.
  "services/users.ts":
    "users table — identity rows (profile, password hash, email verification). No memex_id, no bus entity; user identity is not Memex-scoped tenant content. Memex-creation side effects (memex/created) are emitted by services/user-namespaces.ts and services/users.ts's namespace-provisioning path, not by these raw identity writes.",
  "services/verified-domains.ts":
    "verified_domains + orgs config (domain auto-grouping). Org-level configuration rows, no memex_id, no bus entity — not Memex-scoped tenant content.",
  "services/domain-verification.ts":
    "domain_verification_tokens — short-lived DNS-verification challenge rows. No memex_id, no bus entity; an auth/verification artifact, not tenant content.",
  "services/shared/slug.ts":
    "namespace_slug_reservations — slug-allocation bookkeeping (std-3). No memex_id, no bus entity; an allocation ledger, not Memex-scoped tenant content.",
  "services/test-helpers.ts":
    "Test-only seeding helpers (makeTestMemex et al). Production-shaped source but never imported by runtime code — only by *.test.ts. Seeds raw fixture rows directly; emitting on the bus during seeding would pollute assertions.",
  "services/__test__/seed-org.ts":
    "Test-only org/namespace seeding fixture. Same rationale as services/test-helpers.ts — imported only by tests, seeds raw rows, must not emit.",
  // ── Bus sink ────────────────────────────────────────────────────────────
  "services/activity-log.ts":
    "bus sink — wrapping would recurse on emit. persistEvent() is the single subscriber that writes activity_log rows in response to a bus event; routing its insert through mutate() would emit another event, which the sink would persist, which would emit again. Must stay outside mutate() by construction.",
  // ── Global, non-tenant feed ──────────────────────────────────────────────
  "services/whats-new.ts":
    "Global append-only release-notes feed (spec-200). whats_new_entries has NO memexId/userId — it is one global feed (dec-3), identical for every user, generated at deploy time (dec-1/dec-2). With no tenant/doc entity there is nothing to emit on the memexId-keyed SSE bus; the UI reads it on load (deliberately no live SSE — dec-4). Same category as test-event-latest.ts / activity-log.ts: append-only, must not emit.",
  // ── Code-intelligence ingestion (extractor / repo-data cluster) ──────────
  // std-8 §6 classifies repos, repo_scope, files, symbols, dependencies, calls,
  // embeddings, repo_endpoints, repo_structure, repo_patterns, repo_domains,
  // repo_tech_stack, test_coverage as **silent-allowed**: "Code-intelligence
  // ingestion is server-internal background work; UI subscribers consume
  // aggregated reports on demand, not row-level deltas." There is no `repo` /
  // `file` / `symbol` ChangeEntity in the bus taxonomy (services/bus.ts) and no
  // SSE subscriber on these rows. These services take a `client: Db = db`
  // transaction handle and are driven exclusively by packages/extractor's bulk
  // ingest (packages/extractor/src/ingest.ts), which is keyed on repoId — the
  // memexId a mutate() ChangeKey requires is not threaded through the pipeline.
  // Wrapping them in mutate({silent:true}) would require inventing per-table bus
  // entities AND plumbing memexId through the whole extractor ingest path — a
  // deep refactor outside spec-156's W2 audit scope (which did not flag this
  // cluster). Allowlisted with the silent-allowed classification recorded; the
  // proper mutate({silent:true}) wrap is the follow-up.
  "services/repos.ts":
    "Code-intelligence ingestion (repos / repo_scope). Silent-allowed per std-8 §6 — server-internal extractor background work, no bus entity, no SSE subscriber. Written via a `client: Db` tx handle keyed on repoId; mutate() needs a memexId not threaded through the extractor pipeline. Proper mutate({silent:true}) wrap deferred (needs new bus entities + memexId plumbing).",
  "services/files.ts":
    "Code-intelligence ingestion (files). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/symbols.ts":
    "Code-intelligence ingestion (symbols). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/calls.ts":
    "Code-intelligence ingestion (calls). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/imports.ts":
    "Code-intelligence ingestion (dependencies — file-to-file imports). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/embeddings.ts":
    "Code-intelligence ingestion (embeddings). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/endpoints.ts":
    "Code-intelligence ingestion (repo_endpoints). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/repo-meta.ts":
    "Code-intelligence ingestion (repo_structure / repo_patterns / repo_domains / repo_tech_stack). Silent-allowed per std-8 §6 — extractor background work, no bus entity, no SSE subscriber. Same client:Db/repoId shape as services/repos.ts; mutate() wrap deferred.",
  "services/handhold-demo.ts":
    "Handhold demo seed/reset (spec-178). Its DOCUMENT mutations all go through mutate() (createDocDraft / addSection / createDecision / createTask / createAc, the terminal phase-flip, and the per-doc delete loop). The raw writes the scan flags are NON-document log tables with no SSE doc-entity: the synthetic test_events / test_event_latest emissions seeded so verify/done demo ACs read 'verified' (dec-9 — same category as services/test-event-latest.ts), and the activity_log cleanup on reset (issue-1 / ac-39 — same category as services/activity-log.ts). These are append-only emission/activity logs, not tenant-doc content; they must not emit, exactly like the two log services already allowlisted above.",
};

function isScannableFile(path: string): boolean {
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  return true;
}

function listScannableFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listScannableFiles(full));
    } else if (isScannableFile(full)) {
      out.push(full);
    }
  }
  return out;
}

// Path relative to src/, normalised to posix separators so the allowlist keys
// read the same on every platform (e.g. "services/oauth/codes.ts").
function relKey(absPath: string): string {
  return relative(SRC_DIR, absPath).split(sep).join("/");
}

// Strip line comments and block comments so a `db.update` inside a comment
// doesn't trip the scanner. Keeps line numbers intact by preserving newlines.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      // Line comment — skip to newline.
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src[i] === "/" && src[i + 1] === "*") {
      // Block comment — skip but preserve newlines for line accuracy.
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

interface Match {
  line: number;
  offset: number;
  call: string;
  context: string;
}

// Match a DB-client receiver followed by `.insert(` / `.update(` / `.delete(`.
// `[\s]*` between the receiver and the dot catches the chained-builder form
//   await db
//     .insert(table)
// which the old single-line regex silently skipped (and which let two real
// raw writes slip past — backstage.ts / session.ts).
//
// The receiver set is db | tx | client | conn — every spelling a Drizzle write
// reaches the DB through in this codebase (verified by enumerating receivers
// before .insert/.update/.delete across all SCAN_DIRS). `db` is the module
// singleton; `tx` a transaction handle; `client: Db = db` the parameter the
// extractor/repo-data ingestion threads (services/repos.ts, files.ts,
// symbols.ts, calls.ts, imports.ts, embeddings.ts, endpoints.ts, repo-meta.ts);
// `conn: Db = db` the parameter the OAuth/activity-log services thread. The old
// `(db|tx)`-only regex was blind to the `client.*` / `conn.*` writes — they
// mutated the DB unseen by the scan. Lone identifiers (router.delete on a Hono
// router, Map.delete, cipher.update) are deliberately NOT matched so the scan
// stays free of false positives.
const RAW_WRITE_RE = /\b(db|tx|client|conn)\s*\.\s*(insert|update|delete)\s*\(/g;

// Locate every raw mutating call. Offsets are into `src` (comments stripped).
export function findRawMutationCalls(src: string): Match[] {
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  RAW_WRITE_RE.lastIndex = 0;
  while ((m = RAW_WRITE_RE.exec(src)) !== null) {
    const line = src.slice(0, m.index).split("\n").length;
    // Context = the matched `db.insert(` token itself (whitespace/newlines
    // collapsed) plus the remainder of the call's opening line, so a chained
    // `db\n.insert(` still reports a readable, method-bearing snippet.
    const matchEnd = m.index + m[0].length;
    const lineEnd = src.indexOf("\n", matchEnd);
    const token = m[0].replace(/\s+/g, "");
    const tail = src.slice(matchEnd, lineEnd === -1 ? src.length : lineEnd).trim();
    const ctx = (token + tail).trim();
    matches.push({ line, offset: m.index, call: token, context: ctx });
  }
  return matches;
}

// Byte-ranges [start, end) of every `mutate(` call's argument list (the span
// between its opening `(` and the matching close, paren-balanced and
// string/template-aware so a `(` inside a string literal doesn't unbalance it).
// A write is "wrapped" iff its offset lands inside one of these ranges — this is
// the ac-24 tightening: a raw write AFTER the mutate() call (outside its parens)
// is NOT covered, even though `mutate(` appears earlier in the function.
export function mutateCallbackRanges(src: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /\bmutate\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf("(", m.index);
    if (open === -1) continue;
    const end = matchingParen(src, open);
    if (end === -1) continue;
    ranges.push([open + 1, end]);
  }
  return ranges;
}

// Given the index of an opening `(`, return the index of its matching `)`,
// skipping over string / template / char literals (so parens inside strings
// don't throw the count off). Returns -1 if unbalanced.
function matchingParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i, ch);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Advance past a string/template literal that starts at `i` (the opening quote).
// Returns the index just after the closing quote. Handles backslash escapes;
// template literals are treated as opaque (we don't recurse into ${...}, which
// is fine for the balance check since template `(` are inside the string span).
function skipString(src: string, i: number, quote: string): number {
  i++; // past opening quote
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return i;
}

function isInsideAnyRange(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true;
  }
  return false;
}

// The full scan as a pure, testable function: given a file's raw source, return
// the list of raw writes NOT wrapped by a mutate() callback. The meta-tests run
// this against fixture strings; the per-file suite runs it against real sources.
export function scanForBypasses(rawSource: string): Match[] {
  const src = stripComments(rawSource);
  const writes = findRawMutationCalls(src);
  const ranges = mutateCallbackRanges(src);
  return writes.filter((w) => !isInsideAnyRange(w.offset, ranges));
}

describe("doc-21 t-4 / spec-156 W3: static scan — every mutation goes through mutate()", () => {
  const files = SCAN_DIRS.flatMap((d) => listScannableFiles(join(SRC_DIR, d)));

  it(`finds files to scan across all std-8 §s-3 layers`, () => {
    tagAc(`${AC}/ac-3`); // scope ac-3: enforcement-suite-fails-on-bypass guarantee
    expect(files.length).toBeGreaterThan(20);
    // Sanity: the scan reaches outside services/ now (ac-22 scope).
    const keys = files.map(relKey);
    expect(keys.some((k) => k.startsWith("routes/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("agent/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("mcp/"))).toBe(true);
    expect(keys.some((k) => k.startsWith("middleware/"))).toBe(true);
  });

  for (const file of files) {
    const key = relKey(file);
    const skipReason = ALLOWLIST[key];

    it(`${key}: every raw db/tx mutation is wrapped by mutate()${skipReason ? " — allowlisted" : ""}`, () => {
      const raw = readFileSync(file, "utf8");

      if (skipReason) {
        // Allowlisted: still recorded so a future author who wraps the file's
        // writes is nudged to remove the entry. No assertion on the body.
        return;
      }

      const bypasses = scanForBypasses(raw);

      expect(
        bypasses,
        `${key} has ${bypasses.length} raw db/tx mutation(s) outside a mutate() callback:\n` +
          bypasses.map((b) => `  line ${b.line}: ${b.context}`).join("\n") +
          `\n\nWrap each one in mutate(ctx, key, fn[, {silent:true}]) — see std-8 §5 for the silent-allowed criteria.`,
      ).toEqual([]);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// META-TESTS — prove the scanner itself catches the failure modes std-8 cares
// about. These run the pure scan logic against in-memory fixture sources, so we
// never have to commit a real violating file (spec-156 ac-22..ac-24).
// ───────────────────────────────────────────────────────────────────────────
describe("spec-156 W3: static-scan meta-tests", () => {
  it("ac-22: a seeded raw db write (as would live under routes/) fails the scan", () => {
    tagAc(`${AC}/ac-22`);
    tagAc(`${AC}/ac-3`); // scope ac-3: enforcement-suite-fails-on-bypass guarantee
    // A route handler that writes directly to the DB without mutate() — the
    // exact shape the widened scan must now reject anywhere, not just services/.
    const routeSource = `
      import { db } from "../db/connection.js";
      import { orgMemberships } from "../db/schema.js";
      router.post("/grant", async (c) => {
        const inserted = await db
          .insert(orgMemberships)
          .values({ userId: "u", orgId: "o", role: "admin" })
          .returning();
        return c.json(inserted);
      });
    `;
    const bypasses = scanForBypasses(routeSource);
    expect(bypasses.length).toBe(1);
    expect(bypasses[0].context).toContain(".insert(");
  });

  it("ac-22: a raw client.insert(...) (extractor `client: Db` shape) fails the scan", () => {
    tagAc(`${AC}/ac-22`);
    // The repo-data ingestion threads a `client: Db = db` transaction handle and
    // writes `client.insert(table)`. The old `(db|tx)`-only regex was blind to
    // this receiver spelling, so an entire ingestion cluster mutated the DB
    // unseen by the scan. The widened regex (db|tx|client|conn) must catch it.
    const clientSource = `
      export async function createFiles(rows, client = db) {
        return bulkInsertChunks(rows, (chunk) =>
          client.insert(files).values(chunk).returning(),
        );
      }
    `;
    const bypasses = scanForBypasses(clientSource);
    expect(bypasses.length).toBe(1);
    expect(bypasses[0].context).toContain(".insert(");
  });

  it("ac-22: a raw conn.insert(...) (activity-log / OAuth `conn: Db` shape) fails the scan", () => {
    tagAc(`${AC}/ac-22`);
    // The bus sink and OAuth services thread a `conn: Db = db` handle. Same blind
    // spot as `client` — the widened regex must see `conn.*` writes too (these are
    // then handled per file: activity-log.ts allowlisted as the recursing sink,
    // OAuth writes wrapped in mutate({silent:true})).
    const connSource = `
      export async function persistEvent(event, conn = db) {
        const [row] = await conn.insert(activityLog).values(mapEventToRow(event)).returning();
        return row ?? null;
      }
    `;
    const bypasses = scanForBypasses(connSource);
    expect(bypasses.length).toBe(1);
    expect(bypasses[0].context).toContain(".insert(");
  });

  it("ac-22: the same write wrapped in mutate() passes", () => {
    tagAc(`${AC}/ac-22`);
    const wrapped = `
      router.post("/grant", async (c) => {
        return mutate(ctx, key, async () => {
          const [inserted] = await db
            .insert(orgMemberships)
            .values({ userId: "u", orgId: "o", role: "admin" })
            .returning();
          return inserted;
        });
      });
    `;
    expect(scanForBypasses(wrapped)).toEqual([]);
  });

  it("ac-23: the allowlist is keyed by path relative to src/, not bare basename", () => {
    tagAc(`${AC}/ac-23`);
    // Every key carries a directory segment — none is a bare basename.
    for (const key of Object.keys(ALLOWLIST)) {
      expect(key, `allowlist key "${key}" must be a src/-relative path, not a basename`).toContain("/");
    }
    // The wrapper is allowlisted by its full path.
    expect(ALLOWLIST["services/mutate.ts"]).toBeDefined();
  });

  it("ac-23: a future file merely sharing an allowlisted basename is NOT exempt", () => {
    tagAc(`${AC}/ac-23`);
    // "mutate.ts" is allowlisted only at services/mutate.ts. A hypothetical
    // routes/mutate.ts (same basename, different path) must not inherit the
    // exemption — the allowlist lookup is path-keyed.
    const sameBasenameElsewhere = "routes/mutate.ts";
    expect(ALLOWLIST[sameBasenameElsewhere]).toBeUndefined();
    // And a same-named oauth file outside its real home is likewise unexempt.
    expect(ALLOWLIST["agent/codes.ts"]).toBeUndefined();
  });

  it("ac-24: a wrapped write followed by a SECOND raw write outside the callback fails", () => {
    tagAc(`${AC}/ac-24`);
    // The function DOES contain `mutate(` — the old heuristic ("mutate appears
    // anywhere in the enclosing function") would wave this through. The second
    // db.delete sits AFTER the mutate() call's closing paren, so it is a real
    // bypass and must be flagged.
    const sneaky = `
      export async function doTwoThings(ctx) {
        const created = await mutate(ctx, key, async () => {
          const [row] = await db.insert(widgets).values({}).returning();
          return row;
        });
        // raw write OUTSIDE the mutate() callback — must be caught
        await db.delete(auditRows).where(eq(auditRows.stale, true));
        return created;
      }
    `;
    const bypasses = scanForBypasses(sneaky);
    expect(bypasses.length).toBe(1);
    expect(bypasses[0].context).toContain(".delete(");
  });

  it("ac-24: both writes inside the same mutate() callback pass", () => {
    tagAc(`${AC}/ac-24`);
    const both = `
      export async function doTwoThings(ctx) {
        return mutate(ctx, key, async () => {
          await db.insert(widgets).values({});
          await db.delete(auditRows).where(eq(auditRows.stale, true));
          return null;
        });
      }
    `;
    expect(scanForBypasses(both)).toEqual([]);
  });

  it("ac-24: two separate mutate() callbacks in one function each cover their write", () => {
    tagAc(`${AC}/ac-24`);
    // Mirrors services/dependencies.ts removeDecisionDep (two mutate blocks).
    const twoBlocks = `
      export async function removeDecisionDep(ctx, a, b) {
        if (a) {
          return mutate(ctx, k1, async () => {
            await db.delete(decisionDeps).where(eq(decisionDeps.a, a));
          });
        }
        return mutate(ctx, k2, async () => {
          await db.delete(decisionDeps).where(eq(decisionDeps.b, b));
        });
      }
    `;
    expect(scanForBypasses(twoBlocks)).toEqual([]);
  });

  it("ac-24: parens inside string literals don't unbalance the mutate() span", () => {
    tagAc(`${AC}/ac-24`);
    // A string argument containing ')' must not prematurely close the callback
    // range and leave the real write looking unwrapped.
    const withStringParen = `
      export async function withMsg(ctx) {
        return mutate(ctx, { note: "closes ) early?" }, async () => {
          await db.insert(widgets).values({});
          return null;
        });
      }
    `;
    expect(scanForBypasses(withStringParen)).toEqual([]);
  });

  it("non-db receivers (Map.delete, Hono router.delete) are not flagged", () => {
    const benign = `
      lastViewedAt.delete(k);
      router.delete("/:id", async (c) => c.json({}));
    `;
    expect(scanForBypasses(benign)).toEqual([]);
  });
});
