// spec-560 t-3 (dec-1) — the check that makes the rule survive the Spec.
//
// THE INVARIANT: inside an MCP tool handler, once a write has committed, every
// further `await` runs behind `afterCommit`. A step that runs after the commit must
// never be able to report the committed write as failed.
//
// Why a scan and not a comment: the rule was ALREADY known. Five seams stated it in
// prose (tasks.ts, docs.ts, spec-traffic.ts, mcp/tools.ts) and twelve others missed
// it — including the one that cost a duplicate task in prod on 2026-09-10. A comment
// cannot be checked; this can.
//
// WHAT MAKES IT SELF-MAINTAINING (ac-6): the set of calls that COMMIT is derived, not
// listed. std-8 already forces every mutating service to return `Promise<Mutated<T>>`
// (services/mutate.ts) and `mutate-coverage.static-scan` already guards std-8 — so
// reading that brand out of `services/` yields the commit set for free, and a service
// added tomorrow is covered without touching this file.
//
// SCOPE: `async handler(...)` bodies in `agent/handlers/*.ts` — the tool surface where
// a caller is told whether its write succeeded. Module-level helpers in those files are
// out of scope: they run before or inside a handler, and the handler's own span is what
// the caller's response is composed from.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-560";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const SRC_DIR = join(__dirname, "..");
const HANDLERS_DIR = join(SRC_DIR, "agent", "handlers");
const SERVICES_DIR = join(SRC_DIR, "services");

/** The helper every post-commit step must route through. */
const GUARD = "afterCommit";

// ──────────────────────────────────────────────────────────────────────────
// Allowlist — an exemption carries its reason or it is not an exemption (ac-8).
//
// Keyed by the CALLEE that may follow a commit unguarded. Keying by file (the shape
// `mutate-coverage` uses) is wrong here: an offender is a (commit, callee) pair, and
// exempting whole handler files would gut the check — `tasks.ts` alone holds six
// guarded sites we want to keep guarded. A `path::callee` key narrows an entry to one
// file when a global exemption would be too broad.
// ──────────────────────────────────────────────────────────────────────────
const ALLOWLIST: Record<string, string> = {
  // ── Callees that already cannot throw. The scan reads call sites, not callee
  // bodies, so a step made safe at its OWN seam still looks unguarded from here.
  storeRouteAndReadout:
    "spec-560 t-1: non-fatal inside services/facet-consume.ts — a ballot-store failure returns a warning string and a routing failure returns \"\". Guarding it again at each call site would be redundant.",
  routeAndReadout:
    "spec-560 t-1: same seam — the readout is produced behind afterCommit inside facet-consume.ts and degrades to \"\".",
  stampDocViewFromMcp:
    "spec-448 t-5: swallows its own failures by design (docs.ts) — \"a marker write must never break the tool's real response\". One of the five precedents this Spec generalises.",
  // ── Read-after-write ENRICHMENT. Tracked as issue-1 on spec-560, not waved through.
  // Each of these commits, then reads again to fill in a response field. A failure
  // costs that field — a missing ref, an unrendered READY/BLOCKED marker — where the
  // seven fixed under dec-5 cost a duplicated row, an overwritten resolution, or an
  // edit accepted then reported as rejected. A difference in degree, deliberately not
  // dressed up as a difference in kind.
  //
  // Keyed `path::callee` rather than by callee alone: exempting `getTask` globally
  // would wave through the next high-stakes one too.
  "agent/handlers/lifecycle.ts::getDoc":
    "issue-1 — re-read after a committed phase/flag change (updateDocStatus, groundSpec, setSensitive, supersedeSpec) purely to render the response. Costs a response field; needs a call on what to show when the fresh read is unavailable (probably the pre-write row the handler already holds).",
  "agent/handlers/docs.ts::getDoc":
    "issue-1 — same shape as lifecycle.ts::getDoc: the doc is already updated, this read only renders it back.",
  "agent/handlers/docs.ts::getTask":
    "issue-1 — promote_to_spec re-reads a task to compose its response after the promotion committed.",
  "agent/handlers/docs.ts::resolveRefArg":
    "issue-1 — ref resolution on the promotion path, after the write. Costs the response's ref line.",
  "agent/handlers/tasks.ts::getTask":
    "issue-1 — re-read after addBlocker/removeBlocker/updateTaskStatus to render the READY/BLOCKED marker. The blocker change is committed; a failure loses the marker, and the agent can call list_tasks for it.",
  "agent/handlers/tasks.ts::resolveBlockerRef":
    "issue-1 — resolves the blocker's handle for that same marker, same consequence.",
  "agent/handlers/issues.ts::memexSlugsById":
    "issue-1 — builds the canonical ref after the Issue committed; already degrades to doc.handle on a null return and only needs to stop throwing.",
  "agent/handlers/standards.ts::memexSlugsById":
    "issue-1 — same, on the standards write paths (proposeStandardChange, acceptStandardChange).",
  "agent/handlers/standards.ts::buildStandardCommentRef":
    "issue-1 — composes the drift comment's ref after flagDrift committed. Costs the ref line in the response.",
  "agent/handlers/issues.ts::suggestActiveSpecsForIssue":
    "issue-1 — a semantic-search suggestion appended after the Issue is created. Purely additive context.",
  "agent/handlers/decisions.ts::getDecision":
    "issue-1 — reads the row back on a facet-only edit that changed no content field, to build the response.",
  "agent/handlers/decisions.ts::listDecisions":
    "issue-1 — post-resolve count for the remaining-decisions hint. Costs a sentence.",
  "agent/handlers/acs.ts::fetchTopic":
    "issue-1 — appends the ac-emission guidance topic after the ephemeral key is minted. The key IS in the response; losing the topic costs prose the agent can fetch itself.",
  "agent/handlers/acs.ts::verificationStateForAc":
    "issue-1 — re-reads verification state after discontinue_test_events committed, to report the new state.",
  // ── The verbose branch.
  fullDocState:
    "spec-560 dec-2: the verbose branch IS the response payload — there is nothing to hand back if it fails, so guarding it means inventing a degraded response shape. Named as out of scope in s-3 rather than left silent; its own Spec if it earns one.",
  formatState:
    "spec-560 dec-2: same as fullDocState — the verbose branch renders the response itself rather than decorating it.",
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Strip line + block comments so commented-out code cannot trip or hide the scan. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "");
}

/**
 * ac-6 — derive the committing-call set from std-8's `Promise<Mutated<T>>` brand.
 * Line-based, walking BACK to the nearest `function <name>`: a regex spanning the
 * parameter list crosses function boundaries when a candidate's return type does not
 * match, silently swallowing the next declarations (it dropped `createTask`,
 * `createAc` and `proposeDecision` during this Spec's prototype, which looked exactly
 * like "a scan cannot detect this").
 */
export function deriveCommitSet(sources: string[]): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    const lines = stripComments(src).split("\n");
    lines.forEach((ln, i) => {
      if (!/:\s*Promise<Mutated</.test(ln)) return;
      for (let k = i; k >= 0 && i - k < 60; k--) {
        const m = lines[k].match(/function\s+(\w+)\s*[(<]/);
        if (m) {
          out.add(m[1]);
          return;
        }
      }
    });
  }
  return out;
}

/** Span of the balanced `{...}` opening at or after `from`. */
function braceSpan(src: string, from: number): [number, number] | null {
  const start = src.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") {
      depth--;
      if (depth === 0) return [start, k];
    }
  }
  return null;
}

/** Every `async handler(...) {` body in a handler module. The enclosing FUNCTION,
 *  not the innermost block — a commit nested inside an `if` still owns everything
 *  that follows it in the handler (the prototype's block-scoping missed exactly
 *  that, at tasks.ts:408 and decisions.ts:348). */
function handlerBodies(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of src.matchAll(/async\s+handler\s*\(/g)) {
    const span = braceSpan(src, m.index + m[0].length);
    if (span) out.push(span);
  }
  return out;
}

/** Argument span of each `<name>(` occurrence — used to tell "inside afterCommit(...)"
 *  from "after it". */
function callArgSpans(src: string, name: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const m of src.matchAll(re)) {
    let depth = 0;
    const open = m.index + m[0].length - 1;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "(") depth++;
      else if (src[k] === ")") {
        depth--;
        if (depth === 0) {
          out.push([open, k]);
          break;
        }
      }
    }
  }
  return out;
}

export interface Offender {
  callee: string;
  line: number;
}

/**
 * ac-7 — flag every `await` that follows a committing call inside the same handler
 * body and is not routed through the guard. Knows nothing about which handlers exist,
 * so a handler written tomorrow is scanned on its first run.
 */
export function scanHandler(src: string, commitSet: Set<string>, relPath = ""): Offender[] {
  const clean = stripComments(src);
  const guarded = callArgSpans(clean, GUARD);
  // A thunk parked in `ctx.footerSlot.compute` is guarded too — composeGuidanceEnvelope
  // runs it behind afterCommit (resolveFooterSignal). The guard lives at the SEAT, not
  // at the call site, so the deferred body must be treated as covered here or every
  // correctly-deferred handler reads as an offender.
  const deferred: Array<[number, number]> = [];
  for (const m of clean.matchAll(/footerSlot\.compute\s*=/g)) {
    const span = braceSpan(clean, m.index + m[0].length);
    if (span) deferred.push(span);
  }
  const inGuard = (i: number) =>
    guarded.some(([a, b]) => i > a && i < b) || deferred.some(([a, b]) => i > a && i < b);
  const tryBlocks = [...clean.matchAll(/\btry\s*\{/g)]
    .map((m) => braceSpan(clean, m.index + m[0].length - 1))
    .filter((s): s is [number, number] => s !== null);
  const inTry = (i: number) => tryBlocks.some(([a, b]) => i > a && i < b);

  const lineOf = (i: number) => clean.slice(0, i).split("\n").length;
  // Keyed by LINE, not by (commit, callee). One handler body often holds several
  // mutually-exclusive branches, each with its own commit, so attributing a late
  // await to every earlier commit reports the same site many times over. The
  // question the guard actually asks is per-site: "does a commit precede this
  // await in this handler?" — one answer per line.
  const byLine = new Map<number, Offender>();

  for (const [bodyStart, bodyEnd] of handlerBodies(clean)) {
    const body = clean.slice(bodyStart, bodyEnd);
    for (const c of body.matchAll(/await\s+(\w+)\s*\(/g)) {
      if (!commitSet.has(c[1])) continue;
      const commitAt = bodyStart + c.index;
      if (inGuard(commitAt)) continue; // a commit inside a guard is a different shape
      const after = clean.slice(commitAt + c[0].length, bodyEnd);
      for (const a of after.matchAll(/await\s+(\w+)\s*\(/g)) {
        const at = commitAt + c[0].length + a.index;
        const callee = a[1];
        if (commitSet.has(callee)) continue; // a second commit is not post-commit work
        if (callee === GUARD || inGuard(at) || inTry(at)) continue;
        if (ALLOWLIST[callee] || ALLOWLIST[`${relPath}::${callee}`]) continue;
        const line = lineOf(at);
        if (!byLine.has(line)) byLine.set(line, { callee, line });
      }
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

// ──────────────────────────────────────────────────────────────────────────
// The real corpus
// ──────────────────────────────────────────────────────────────────────────

const serviceSources = readdirSync(SERVICES_DIR, { recursive: true, encoding: "utf8" })
  .filter((p) => p.endsWith(".ts") && !p.includes(".test."))
  .map((p) => readFileSync(join(SERVICES_DIR, p), "utf8"));

const COMMIT_SET = deriveCommitSet(serviceSources);

const handlerFiles = readdirSync(HANDLERS_DIR)
  .filter((n) => n.endsWith(".ts") && !n.includes(".test."))
  .map((n) => join(HANDLERS_DIR, n));

describe("spec-560 — a step after the commit never reports the write as failed", () => {
  it("ac-6: the commit set is DERIVED from Promise<Mutated<T>>, not hand-listed", () => {
    tagAc(AC(6));
    // Non-trivial, and it contains the verbs this Spec was written about.
    expect(COMMIT_SET.size).toBeGreaterThan(50);
    for (const verb of ["createTask", "createAc", "createDecision", "resolveDecision"]) {
      expect(COMMIT_SET.has(verb), `${verb} must be recognised as a commit`).toBe(true);
    }
  });

  it("ac-6: a NEW branded service extends the set with no edit to this guard", () => {
    tagAc(AC(6));
    const brandNew = `export async function createWidget(a: string): Promise<Mutated<Widget>> {}`;
    expect(deriveCommitSet([brandNew]).has("createWidget")).toBe(true);
    // …and dropping the brand drops it from the set.
    const unbranded = `export async function createWidget(a: string): Promise<Widget> {}`;
    expect(deriveCommitSet([unbranded]).has("createWidget")).toBe(false);
  });

  it("ac-9: every handler body is clean — no site both unguarded and unexplained", () => {
    tagAc(AC(9));
    tagAc(AC(4)); // scope: the audit is complete, not just the site the incident exposed.
    const found: string[] = [];
    for (const f of handlerFiles) {
      const rel = relative(SRC_DIR, f).split(sep).join("/");
      for (const o of scanHandler(readFileSync(f, "utf8"), COMMIT_SET, rel)) {
        found.push(`${rel}:${o.line} — ${o.callee}`);
      }
    }
    expect(
      found,
      `post-commit work not routed through ${GUARD}():\n  ${found.join("\n  ")}\n\n` +
        `Wrap it in ${GUARD}(label, () => …), or add the callee to ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  it("ac-7: a NEW unguarded commit-then-work pair fails, though neither is known here", () => {
    tagAc(AC(7));
    // ac-5: this IS the mechanism that acts without being remembered. The author of a
    // handler that has never existed gets a red check, having read nothing. The
    // Standard half (std-53, surfaced by facet routing) documents the two failure
    // classes the scan cannot express; the scan is what holds the line.
    tagAc(AC(5));
    const fresh = `
      export const x = [{ name: "brand_new_tool", async handler(input, ctx) {
        const row = await createTask(a, b);
        const extra = await lookupSomethingElse(row.id);
        return "ok";
      } }];`;
    const offenders = scanHandler(fresh, COMMIT_SET);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].callee).toBe("lookupSomethingElse");
  });

  it("ac-7: the same pair routed through the guard passes", () => {
    tagAc(AC(7));
    const wrapped = `
      export const x = [{ name: "brand_new_tool", async handler(input, ctx) {
        const row = await createTask(a, b);
        const extra = await afterCommit("extra", () => lookupSomethingElse(row.id));
        return "ok";
      } }];`;
    expect(scanHandler(wrapped, COMMIT_SET)).toEqual([]);
  });

  it("ac-7: a commit nested in an `if` still owns what follows — the block-scoping miss", () => {
    tagAc(AC(7));
    // The prototype scoped its forward scan to the innermost BLOCK, so a commit inside
    // an `if` stopped the scan at that `if`'s closing brace. tasks.ts:408 and
    // decisions.ts:348 both have exactly this shape and were both missed.
    const nested = `
      export const x = [{ name: "t", async handler(input, ctx) {
        if (cond) {
          const row = await updateTask(a);
        }
        const late = await someLaterRead(1);
        return "ok";
      } }];`;
    const offenders = scanHandler(nested, COMMIT_SET);
    expect(offenders.map((o) => o.callee)).toContain("someLaterRead");
  });

  it("ac-7: work BEFORE the commit is not flagged — validation must stay fatal", () => {
    tagAc(AC(7));
    tagAc(AC(11)); // the boundary spec-499 depends on.
    const before = `
      export const x = [{ name: "t", async handler(input, ctx) {
        const vocab = await requireBallotForMemex(m, i, o);
        const row = await createTask(a, b);
        return "ok";
      } }];`;
    expect(scanHandler(before, COMMIT_SET)).toEqual([]);
  });

  it("ac-8: every allowlist entry carries a non-empty reason", () => {
    tagAc(AC(8));
    for (const [callee, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `${callee} is exempt with no reason`).toBeGreaterThan(40);
    }
  });

  it("ac-8: an exemption without a reason is not an exemption", () => {
    tagAc(AC(8));
    // The check that makes the entry above meaningful: a reason-less entry is rejected
    // by the same predicate, so nobody can quiet the guard by adding a bare key.
    const bogus: Record<string, string> = { somethingQuiet: "  " };
    const offenders = Object.entries(bogus).filter(([, r]) => r.trim().length <= 40);
    expect(offenders).toHaveLength(1);
  });

it("ac-19: enrichment exemptions are keyed path::callee and name their tracking artifact", () => {
    tagAc(AC(19));
    const enrichment = Object.keys(ALLOWLIST).filter((k) => ALLOWLIST[k].startsWith("issue-1"));
    expect(enrichment.length, "the tracked enrichment set must not be empty").toBeGreaterThan(10);
    for (const key of enrichment) {
      // Bare-callee keys exempt that callee EVERYWHERE. An enrichment site is exempt
      // because of what it does in ITS file, so it must be scoped to that file.
      expect(key, `${key} exempts a callee globally`).toContain("::");
      expect(key.startsWith("agent/handlers/"), `${key} is not a handler path`).toBe(true);
    }
    // And the four non-enrichment entries are the ones that are safe everywhere:
    // callees that cannot throw, plus the verbose branch.
    const global = Object.keys(ALLOWLIST).filter((k) => !k.includes("::"));
    expect(global.sort()).toEqual(
      ["formatState", "fullDocState", "routeAndReadout", "stampDocViewFromMcp", "storeRouteAndReadout"].sort(),
    );
  });

  it("ac-19: a bare-callee key does not exempt a path-keyed lookup, and vice versa", () => {
    tagAc(AC(19));
    // The lookup consults `callee` and `path::callee`; nothing else. A file that merely
    // shares a callee with an exempt file is still scanned.
    const src = `
      export const x = [{ name: "t", async handler(input, ctx) {
        const row = await createTask(a, b);
        const t = await getTask(m, row.id);
        return "ok";
      } }];`;
    // tasks.ts exempts getTask; a different file does not.
    expect(scanHandler(src, COMMIT_SET, "agent/handlers/tasks.ts")).toEqual([]);
    expect(scanHandler(src, COMMIT_SET, "agent/handlers/brand-new.ts").map((o) => o.callee)).toEqual([
      "getTask",
    ]);
  });

it("ac-16: this Spec adds no deadline at the MCP dispatch seam — incident 2 is NOT claimed", () => {
    tagAc(AC(16));
    // A scope guard, not a behaviour. spec-560 fixes the response to incident 1 (a
    // transient AFTER the commit). Incident 2 — the 305s silence from postgres-js's
    // unbounded pool queue — is a sibling Spec (dec-4), and a call that outlives its
    // client remains possible after this ships. Asserted so nobody records it as
    // fixed here, and so the sibling's remit stays real.
    const dispatch = readFileSync(join(SRC_DIR, "mcp", "tools.ts"), "utf8");
    const wrapAt = dispatch.indexOf("const text = await fn(input)");
    expect(wrapAt, "the dispatch wrap moved — re-ground this assertion").toBeGreaterThan(0);
    const wrap = dispatch.slice(Math.max(0, wrapAt - 2000), wrapAt + 2000);
    for (const deadline of ["setTimeout", "AbortController", "Promise.race", "AbortSignal.timeout"]) {
      expect(wrap, `${deadline} appeared at the dispatch seam — that is the sibling Spec's change`).not.toContain(
        deadline,
      );
    }
  });

  it("commented-out code neither trips nor hides the scan", () => {
    tagAc(AC(7));
    const commented = `
      export const x = [{ name: "t", async handler(input, ctx) {
        const row = await createTask(a, b);
        // const stale = await oldRead(1);
        /* const alsoStale = await olderRead(1); */
        return "ok";
      } }];`;
    expect(scanHandler(commented, COMMIT_SET)).toEqual([]);
  });
});
