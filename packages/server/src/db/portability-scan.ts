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
  {
    label: "literal entity handle (std-N / spec-N / dec-N / ac-N / doc-N / cl-N / t-N)",
    pattern: /\b(std|spec|dec|ac|doc|cl|t)-\d+\b/i,
  },
];

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
];

/**
 * Scan fixture strings for non-portable tokens. Returns one readable violation line per
 * (string, rule) hit — empty when the fixture is clean. Callers supply the adapter that
 * flattens their own fixture shape into `Scannable`s.
 */
export function scanForNonPortableTokens(items: readonly Scannable[]): string[] {
  const violations: string[] = [];
  for (const { where, text } of items) {
    for (const rule of FORBIDDEN) {
      const match = text.match(rule.pattern);
      if (match) violations.push(`[${where}] ${rule.label}: matched "${match[0]}" in: ${text}`);
    }
  }
  return violations;
}

/**
 * Guards the guard: returns any known-bad sample the deny-list FAILS to flag. Empty is
 * the healthy state. A caller asserts on this rather than on the patterns themselves,
 * so the rules stay private and the assertion survives a rewrite of them.
 */
export function canarySamplesNotFlagged(): string[] {
  return CANARY_SAMPLES.filter((sample) => !FORBIDDEN.some((rule) => rule.pattern.test(sample)));
}
