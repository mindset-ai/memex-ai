// spec-184 t-5 — std-22 portability guard over the default-Standards fixture.
//
// The six default Standards are seeded into a stranger's Memex over a codebase we
// can't see (spec-184). Per std-22 their text MUST NOT name a file path or layout, a
// language/framework, a test runner / build tool / package manager, a project-specific
// symbol, or a `std-N` handle — those would be meaningless (or wrong) in a customer's
// workspace. This test scans every title + clause and fails on any such token, so the
// fixture can't drift out of portability on a later edit. Verifies spec-184 ac-17.
//
// Precision over recall: the forbidden patterns are chosen to catch the std-22 example
// violations WITHOUT flagging ordinary English. In particular we do NOT match bare
// words that are also prose ("make", "go", "build", "react") — only unambiguous tool
// tokens, proper-noun framework names, handle literals, and path shapes.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { DEFAULT_STANDARDS } from "./default-standards.fixture.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-184/acs/ac-${n}`;

interface ForbiddenRule {
  label: string;
  pattern: RegExp;
}

// Each pattern is high-precision. Comments note why a token is safe to match as-is
// (unambiguous) vs. why a prose-colliding token (make/go/build/react) is deliberately
// NOT matched bare.
const FORBIDDEN: ForbiddenRule[] = [
  // ── File paths & repo layout ────────────────────────────────────────────────
  { label: "repo directory path", pattern: /\b(packages|src|dist|node_modules|tests?)\//i },
  { label: "dunder test dir (e.g. __regression__)", pattern: /__[a-z]+__/i },
  { label: "source file with code extension", pattern: /\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|php)\b/i },

  // ── Test runners / build tools / package managers / runtimes (unambiguous tokens) ──
  { label: "test runner / build / package-manager name", pattern: /\b(vitest|jest|mocha|pytest|rspec|pnpm|npm|yarn|bun|deno|webpack|vite|eslint|prettier|gradle|maven|tsc)\b/i },
  { label: "Makefile / make target", pattern: /\bMakefile\b|\bmake\s+(test|build|dev|deploy|run)\b/i },

  // ── Language / framework proper nouns (capitalised proper nouns, not prose) ──
  { label: "language/framework name", pattern: /\b(TypeScript|JavaScript|Python|Golang|Java|Kotlin|Scala|Rust|Ruby|Hono|Drizzle|Postgres(QL)?|Django|Rails|Vue|Svelte|Angular)\b/ },
  // "React" only as the proper noun (capital R) — avoids the verb "react".
  { label: "React framework reference", pattern: /\bReact\b/ },
  { label: "C-family language token", pattern: /C\+\+|C#/ },
  // Infra / VCS proper nouns. `\bgit\b` is word-bounded so it never trips prose like
  // "legitimate" / "digit"; the rest are unambiguous capitalised names.
  { label: "infra / VCS proper noun", pattern: /\b(Docker|Kubernetes|Terraform|GitHub|GitLab)\b|\bgit\b/i },

  // ── Project-specific symbols that only exist in memex-app ────────────────────
  { label: "project-specific symbol", pattern: /\b(tagAc|createDocDraft|addSection|addClausesToSection|seedDefaultStandards|ensureUserNamespace)\b/ },
  { label: "mutate() call / is_demo|is_default column", pattern: /\bmutate\(|\bis_demo\b|\bis_default\b|\bis_seed\b/ },

  // ── This Memex's own handles by literal (std-N etc.) ────────────────────────
  { label: "literal entity handle (std-N / spec-N / dec-N / ac-N / doc-N / cl-N / t-N)", pattern: /\b(std|spec|dec|ac|doc|cl|t)-\d+\b/i },
];

// Every scannable string in the fixture, with a location label for failure messages.
function scannableStrings(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const std of DEFAULT_STANDARDS) {
    out.push({ where: `${std.key} / title`, text: std.title });
    for (const section of std.sections) {
      out.push({ where: `${std.key} / ${section.sectionType} / title`, text: section.title });
      section.clauses.forEach((c, i) => {
        out.push({ where: `${std.key} / ${section.sectionType} / cl[${i}]`, text: c });
      });
    }
  }
  return out;
}

describe("spec-184: default Standards are std-22-portable (ac-17)", () => {
  it("contains no path, tooling, language, project-symbol, or handle tokens", () => {
    tagAc(AC(17));
    tagAc(AC(3)); // scope ac-3: every default is portable per std-22

    const violations: string[] = [];
    for (const { where, text } of scannableStrings()) {
      for (const rule of FORBIDDEN) {
        const m = text.match(rule.pattern);
        if (m) {
          violations.push(`[${where}] ${rule.label}: matched "${m[0]}" in: ${text}`);
        }
      }
    }

    expect(violations, `Non-portable tokens found:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the forbidden-token list itself catches a known-bad sample (guards the guard)", () => {
    tagAc(AC(17));
    // If a future refactor neuters the patterns, this canary fails.
    const bad = [
      "grep packages/server/src/__regression__ for the test",
      "run pnpm vitest",
      "tag the assertion with tagAc",
      "see std-17 for the rule",
      "edit the TypeScript file",
      "build the Docker image and commit with git",
      "the Ruby on Rails service",
      "written in Rust, deployed via deno",
    ];
    for (const sample of bad) {
      const hit = FORBIDDEN.some((r) => r.pattern.test(sample));
      expect(hit, `expected to flag: ${sample}`).toBe(true);
    }
  });
});
