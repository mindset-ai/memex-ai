// std-22 portability scanning for the product-default fixtures.
//
// Extracted from default-standards.portability.test.ts (spec-184 t-5) when spec-545
// gave it a second consumer: the default FACET vocabulary needs the same scan, over a
// different fixture shape. One deny-list with two adapters is a seam; two copies of
// thirteen regexes is drift waiting to happen — the first edit to one list silently
// stops protecting the other fixture [per std-51].
//
// WHAT THIS ENFORCES. Everything seeded into a stranger's Memex sits on a codebase we
// cannot see. Per std-22 its text MUST NOT name a file path or layout, a language or
// framework, a test runner / build tool / package manager, a project-specific symbol,
// or one of this Memex's own entity handles — every one of those is meaningless, or
// actively wrong, in a customer's workspace.
//
// The interface is two functions that each return a list of problems (empty = clean).
// The patterns and the canary corpus stay private: a caller that could reach the raw
// deny-list would be tempted to filter it per fixture, which is exactly the divergence
// this module exists to prevent.

/** One scannable string plus a location label used in failure messages. */
export interface Scannable {
  readonly where: string;
  readonly text: string;
}

interface ForbiddenRule {
  readonly label: string;
  readonly pattern: RegExp;
}

// Declared before FORBIDDEN so a named group (below) can reference it without
// fishing it back out of the list by label — a label is prose, and matching on it
// would break the first time someone rewords it.
// What is forbidden is a BARE handle — one the reader cannot resolve. A handle inside
// a FULLY QUALIFIED canonical ref is the opposite: std-10 §6 mandates that form for
// any cross-document reference precisely BECAUSE it resolves for whoever reads it.
//
// So the lookbehind exempts `<namespace>/<memex>/<doc-type>/`. Without it the rule
// contradicts the remedy the Standard prescribes: spec-551 dec-1 qualifies the
// citations that name rules about Memex itself (a customer's workspace will never
// hold them, so "search your own Standards" would point at a guaranteed void), and
// a rule that flagged those would leave no correct way to cite anything at all.
//
// Deliberately NOT exempted: a handle after a bare doc-type (`standards/std-N`) or
// after one path segment. Two segments before the doc-type is what makes a ref
// addressable — anything shorter is a fragment that still resolves nowhere.
const QUALIFIED_REF_PREFIX = String.raw`(?<![\w-])[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/(?:specs|docs|standards|execution-plans)\/`;

const ENTITY_HANDLE_RULE: ForbiddenRule = {
  label: "bare entity handle (std-N / spec-N / dec-N / ac-N / doc-N / cl-N / t-N)",
  pattern: new RegExp(String.raw`(?<!${QUALIFIED_REF_PREFIX})\b(std|spec|dec|ac|doc|cl|t)-\d+\b`, "i"),
};

// Precision over recall: each pattern catches the std-22 example violations WITHOUT
// flagging ordinary English. In particular bare words that are also prose — "make",
// "go", "build", "react" — are deliberately NOT matched; only unambiguous tool tokens,
// proper-noun framework names, handle literals, and path shapes.
const FORBIDDEN: readonly ForbiddenRule[] = [
  // ── File paths & repo layout ────────────────────────────────────────────────
  { label: "repo directory path", pattern: /\b(packages|src|dist|node_modules|tests?)\//i },
  { label: "dunder test dir (e.g. __regression__)", pattern: /__[a-z]+__/i },
  {
    label: "source file with code extension",
    pattern: /\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|php)\b/i,
  },

  // ── Test runners / build tools / package managers / runtimes ────────────────
  {
    label: "test runner / build / package-manager name",
    pattern:
      /\b(vitest|jest|mocha|pytest|rspec|pnpm|npm|yarn|bun|deno|webpack|vite|eslint|prettier|gradle|maven|tsc)\b/i,
  },
  { label: "Makefile / make target", pattern: /\bMakefile\b|\bmake\s+(test|build|dev|deploy|run)\b/i },

  // ── Language / framework proper nouns (capitalised proper nouns, not prose) ──
  {
    label: "language/framework name",
    pattern:
      /\b(TypeScript|JavaScript|Python|Golang|Java|Kotlin|Scala|Rust|Ruby|Hono|Drizzle|Postgres(QL)?|Django|Rails|Vue|Svelte|Angular)\b/,
  },
  // "React" only as the proper noun (capital R) — avoids the verb "react".
  { label: "React framework reference", pattern: /\bReact\b/ },
  { label: "C-family language token", pattern: /C\+\+|C#/ },
  // Infra / VCS proper nouns. `\bgit\b` is word-bounded so it never trips prose like
  // "legitimate" / "digit"; the rest are unambiguous capitalised names.
  { label: "infra / VCS proper noun", pattern: /\b(Docker|Kubernetes|Terraform|GitHub|GitLab)\b|\bgit\b/i },

  // ── Language-specific module keywords (spec-545 ac-8) ───────────────────────
  // A description that says "what a module exports" reads as neutral English but names
  // a keyword that does not exist in every language; "what a module offers its callers"
  // is the portable phrasing. Word-bounded, so "important" and "importance" are safe.
  { label: "language-specific module keyword", pattern: /\bexports?\b|\bimports?\b/i },

  // ── Project-specific symbols that only exist in this codebase ───────────────
  {
    label: "project-specific symbol",
    pattern:
      /\b(tagAc|createDocDraft|addSection|addClausesToSection|seedDefaultStandards|ensureUserNamespace)\b/,
  },
  { label: "mutate() call / is_demo|is_default column", pattern: /\bmutate\(|\bis_demo\b|\bis_default\b|\bis_seed\b/ },

  // ── This Memex's own handles by literal (std-N etc.) ────────────────────────
  ENTITY_HANDLE_RULE,
];

// ── Named rule GROUPS (spec-551 dec-6) ───────────────────────────────────────
//
// A group is declared HERE, never assembled by a caller. The reason is the one in
// this module's header: a caller that could pick rules would be tempted to drop the
// ones it finds inconvenient, and the fixtures relying on this list would drift
// apart. So the choice a caller gets is "which named group", not "which rules".
//
// `ENTITY_HANDLES` exists because the rendered-prose surface (scaffold, guidance
// bodies, live tool contract) reaches this module carrying a large, pre-existing,
// UNSCOPED backlog against the other twelve rules: 104 hits, of which the biggest
// cluster is the AC-emitter manifest naming `pytest` / `Jest` / `npm install` —
// which is that table's content, not a portability defect. spec-551 scoped the
// handle rule and only the handle rule; a guard that also cried about the other 104
// would be switched off inside a week, taking the 193 real findings with it.
//
// This narrows NOTHING that was already enforced: both seeded fixtures keep scanning
// through the full list.
const GROUPS = {
  ENTITY_HANDLES: [ENTITY_HANDLE_RULE] as readonly ForbiddenRule[],
} as const;

// Known-bad strings that the deny-list MUST flag. If a future refactor neuters a
// pattern, `canarySamplesNotFlagged()` names the sample that stopped being caught —
// without which a guard can quietly degrade to always-green.
const CANARY_SAMPLES: readonly string[] = [
  "grep packages/server/src/__regression__ for the test",
  "run pnpm vitest",
  "tag the assertion with tagAc",
  "see std-17 for the rule",
  "edit the TypeScript file",
  "build the Docker image and commit with git",
  "the Ruby on Rails service",
  "written in Rust, deployed via deno",
  "adding to what a module exports",
  "the symbols a file imports",
  // spec-551 t-2 (ac-15): one sample per NEW adapter, in that adapter's own shape.
  // The samples above are clause-sized, so they would still pass if a walk over the
  // scaffold or the tool contract quietly stopped enumerating. These are the shapes
  // those adapters actually carry — a nudge sentence, a guidance-topic aside, and an
  // MCP tool description — so the canary notices when one of them goes dark.
  "Missing core lens: Design & UX. std-18 names three core lenses every Spec should carry",
  "(The motivating incident: spec-118 ac-7 was split from one combined test into three.)",
  "Register a bug/todo Issue against a Spec — no silent default home (std-5).",
  // One per handle class the deny-list claims to cover, so a future narrowing of the
  // rule to `std-N` is named by a red canary rather than passing in silence.
  "see spec-17 for the rule",
  "see dec-17 for the rule",
  "see ac-17 for the rule",
  "see cl-17 for the rule",
  "see t-17 for the rule",
  "see doc-17 for the rule",
];

/** How much surrounding text a violation line carries, each side of the match. */
const EXCERPT_RADIUS = 70;

/** The match, with enough of its neighbourhood to find it by eye. */
function excerpt(text: string, at: number, length: number): string {
  const from = Math.max(0, at - EXCERPT_RADIUS);
  const to = Math.min(text.length, at + length + EXCERPT_RADIUS);
  const body = text.slice(from, to).replace(/\s+/g, " ");
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

/**
 * Scan strings for non-portable tokens. Returns one readable violation line per
 * OCCURRENCE — empty when clean. Callers supply the adapter that flattens their own
 * fixture shape into `Scannable`s.
 *
 * spec-551 t-2 (ac-8): per occurrence, not per (string, rule). This used to report the
 * first match only, which is harmless on clause-sized fixtures and actively misleading
 * on the scaffold, whose strings run to thousands of characters: a string carrying five
 * bare handles reported one, you fixed the one it named, the scan went green, and four
 * shipped. That silent-partial-success is the very shape spec-551 exists to close, so it
 * must not live inside spec-551's own guard.
 *
 * The patterns stay non-global. A `/g` regex carries `lastIndex` between calls, which
 * would make `canarySamplesNotFlagged`'s `.test()` alternate true/false — a guard that
 * fails every other run gets deleted. The global copy is per-call and local.
 */
export function scanForNonPortableTokens(items: readonly Scannable[]): string[] {
  return scan(items, FORBIDDEN);
}

/**
 * Scan through the ENTITY_HANDLES group: this Memex's own handles by literal, and
 * nothing else. See the note on `GROUPS` for why a group exists and why a caller
 * cannot build its own.
 */
export function scanForEntityHandles(items: readonly Scannable[]): string[] {
  return scan(items, GROUPS.ENTITY_HANDLES);
}

function scan(items: readonly Scannable[], rules: readonly ForbiddenRule[]): string[] {
  // One authored string can be rendered at many sites — a shared description
  // fragment reaches ~24 tool contracts, so scanning per site reported the same
  // defect 24 times and buried the singular ones. The FIX unit is the authored
  // string, so findings key on (text, position) and carry the extra site count.
  // ac-8's promise is untouched: every occurrence WITHIN a string still reports.
  const byOccurrence = new Map<string, { line: string; sites: string[] }>();

  for (const { where, text } of items) {
    for (const rule of rules) {
      const flags = rule.pattern.flags.includes("g")
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      for (const match of text.matchAll(new RegExp(rule.pattern.source, flags))) {
        const at = match.index ?? 0;
        const key = `${rule.label} ${at} ${text}`;
        const existing = byOccurrence.get(key);
        if (existing) {
          existing.sites.push(where);
          continue;
        }
        byOccurrence.set(key, {
          line: `[${where}] ${rule.label}: matched "${match[0]}" in: ${excerpt(text, at, match[0].length)}`,
          sites: [],
        });
      }
    }
  }

  return [...byOccurrence.values()].map(({ line, sites }) =>
    sites.length === 0
      ? line
      : `${line} (+${sites.length} more site${sites.length === 1 ? "" : "s"}: ${sites.slice(0, 3).join(", ")}${sites.length > 3 ? ", …" : ""})`,
  );
}

/**
 * Guards the guard: returns any known-bad sample the deny-list FAILS to flag. Empty is
 * the healthy state. A caller asserts on this rather than on the patterns themselves,
 * so the rules stay private and the assertion survives a rewrite of them.
 */
export function canarySamplesNotFlagged(): string[] {
  return CANARY_SAMPLES.filter((sample) => !FORBIDDEN.some((rule) => rule.pattern.test(sample)));
}
