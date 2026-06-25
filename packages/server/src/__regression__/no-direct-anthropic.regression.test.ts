// Static-scan guard for std-30: the metering wrapper is the only sanctioned
// path to an LLM, so direct `new Anthropic(...)` construction is forbidden
// anywhere but inside the wrapper module.
//
// std-30 §s-1 cl-2: "No code outside the wrapper may instantiate a provider SDK
// client: no `new Anthropic(...)` [...] anywhere but inside the wrapper module."
// cl-5: "This rule is enforced by lint, not convention [...] so a bypass fails
// CI rather than relying on a reviewer to catch it." This test IS that
// enforcement: it scans every `packages/server/src/**/*.ts` source file (tests,
// `.d.ts`, and build output excluded) for a `new Anthropic(` construction and
// asserts the ONLY site is the one allowlisted metering wrapper — the file where
// `getAnthropicClient()` lives (agent/anthropic-client.ts). A chokepoint that
// can be bypassed is not a chokepoint (cl-7): one escaped call site silently
// corrupts every per-tenant cost figure.
//
// The scan is comment/string-aware (it reuses the same stripComments approach
// proven by mutate-coverage.static-scan.test.ts): a `new Anthropic(` mentioned
// inside a // comment, a /* block */, or a string/template literal does NOT
// trip it — only a real construction in code does.
//
// Allowlist: a single path-keyed entry (relative to src/, posix separators),
// matching how the sibling scanners allowlist. Each entry carries its reason.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const AC = "mindset-prod/memex-building-itself/specs/spec-387/acs";

// packages/server/src — the std-30 §s-3 cl-11 scope for the server package.
const SRC_DIR = join(__dirname, "..");

// The ONE file allowed to construct the Anthropic SDK client: the metering
// wrapper itself (std-30 §s-3 cl-13 — "the one exempt module [...] where the SDK
// clients live"). Keyed by path RELATIVE TO src/ (posix separators) so a future
// file that merely shares the basename is NOT exempt.
const ALLOWLIST: Record<string, string> = {
  "agent/anthropic-client.ts":
    "The metering wrapper itself — getAnthropicClient() lives here; std-30 §s-3 cl-13 names it the one exempt module where the SDK client is instantiated.",
};

// Directory basenames we never descend into.
const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "build", "coverage"]);

function isScannableFile(path: string): boolean {
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".test.ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  return true;
}

function listScannableFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
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
// read the same on every platform (e.g. "agent/anthropic-client.ts").
function relKey(absPath: string): string {
  return relative(SRC_DIR, absPath).split(sep).join("/");
}

// Skip a string / char / template literal, returning the index just past its
// closing quote. Handles backslash escapes. (Mirrors the helper in
// mutate-coverage.static-scan.test.ts.)
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

// Strip line comments, block comments, AND string/template-literal interiors so
// a `new Anthropic(` inside a comment OR a string does not trip the scanner.
// Keeps line numbers (and offsets) intact by preserving newlines and replacing
// stripped content with spaces. String-literal-aware in the same spirit as
// mutate-coverage.static-scan.test.ts (a quote-embedded `/*` or `//` is NOT a
// comment), but here we go one step further and blank the literal's interior
// too: unlike a DB write, the substring `new Anthropic(` plausibly appears
// inside a doc string or error message, so the interior must not be scanned.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // String / char / template literal — blank the interior (keep the quotes
      // and any newlines so line/offset accuracy survives) so neither a comment
      // marker NOR a `new Anthropic(` inside it is ever matched.
      const end = skipString(src, i, ch);
      const literal = src.slice(i, end);
      out += literal.replace(/[^\n]/g, " ");
      i = end;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

interface Construction {
  line: number;
  context: string;
}

// Match a direct construction of the Anthropic SDK client. `new` followed by
// `Anthropic` and an opening paren — tolerant of arbitrary whitespace and a
// generic type-argument list between the name and the `(` (e.g.
// `new Anthropic <Foo>(`). The `\b` after `Anthropic` ensures we don't match a
// longer identifier like `AnthropicLike` or `AnthropicBedrock`.
const NEW_ANTHROPIC_RE = /\bnew\s+Anthropic\b\s*(?:<[^>]*>\s*)?\(/g;

// Pure, testable core: given a file's raw source, return every direct Anthropic
// construction (comments/strings stripped first).
export function findDirectAnthropicConstructions(src: string): Construction[] {
  const stripped = stripComments(src);
  const out: Construction[] = [];
  let m: RegExpExecArray | null;
  NEW_ANTHROPIC_RE.lastIndex = 0;
  while ((m = NEW_ANTHROPIC_RE.exec(stripped)) !== null) {
    const line = stripped.slice(0, m.index).split("\n").length;
    const lineEnd = stripped.indexOf("\n", m.index);
    const context = stripped
      .slice(m.index, lineEnd === -1 ? stripped.length : lineEnd)
      .trim();
    out.push({ line, context });
  }
  return out;
}

describe("std-30: no direct `new Anthropic(` outside the metering wrapper", () => {
  const files = listScannableFiles(SRC_DIR);

  it("finds server source files to scan", () => {
    tagAc(`${AC}/ac-2`);
    expect(files.length).toBeGreaterThan(20);
  });

  it("the allowlisted metering wrapper exists and is scanned", () => {
    tagAc(`${AC}/ac-2`);
    const keys = files.map(relKey);
    for (const allowed of Object.keys(ALLOWLIST)) {
      expect(keys, `allowlisted file missing from scan: ${allowed}`).toContain(
        allowed,
      );
    }
  });

  // One assertion per file so a single violation names the exact file + line.
  for (const file of files) {
    const key = relKey(file);
    const allowReason = ALLOWLIST[key];
    it(`${key}: no direct \`new Anthropic(\`${allowReason ? " — allowlisted (wrapper)" : ""}`, () => {
      tagAc(`${AC}/ac-2`); // scope ac-2
      tagAc(`${AC}/ac-7`); // implementation ac-7: the per-file scan + single allowlist
      const src = readFileSync(file, "utf8");
      const hits = findDirectAnthropicConstructions(src);

      if (allowReason) {
        // The wrapper is the one place this is legitimate — assert nothing more.
        return;
      }

      expect(
        hits,
        hits.length
          ? `std-30 violation: ${key} constructs the Anthropic SDK client directly ` +
              `(line ${hits[0].line}: \`${hits[0].context}\`).\n` +
              `std-30 (the metering wrapper is the only sanctioned path) forbids ` +
              `\`new Anthropic(...)\` anywhere but the wrapper module — all LLM ` +
              `access goes through getAnthropicClient() so metering stays complete. ` +
              `Call getAnthropicClient() (packages/server/src/agent/anthropic-client.ts) ` +
              `instead; if the wrapper lacks a capability you need, extend the ` +
              `wrapper (std-30 cl-6) — never reach around it to the SDK. If this ` +
              `file legitimately IS a wrapper module, add it to ALLOWLIST with a reason.`
          : "",
      ).toEqual([]);
    });
  }
});

describe("std-30 scanner meta-tests (catch-a-violation)", () => {
  it("flags a real direct construction in code", () => {
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-4`); // scope ac-4: the guard goes red on a real violation
    tagAc(`${AC}/ac-5`); // scope ac-5: the hit carries the line + context to name in the failure
    const offending = `
      import Anthropic from "@anthropic-ai/sdk";
      function make() {
        return new Anthropic({ apiKey: "x" });
      }
    `;
    const hits = findDirectAnthropicConstructions(offending);
    expect(hits.length).toBe(1);
    expect(hits[0].context).toContain("new Anthropic(");
    // ac-5: the match records the offending line number + a readable context
    // snippet — the two facts the per-file failure message names.
    expect(hits[0].line).toBeGreaterThan(0);
  });

  it("flags the whitespace / generic-arg variants", () => {
    tagAc(`${AC}/ac-2`);
    expect(findDirectAnthropicConstructions("new   Anthropic ({})").length).toBe(
      1,
    );
    expect(findDirectAnthropicConstructions("new Anthropic<Foo>({})").length).toBe(
      1,
    );
  });

  it("does NOT flag a construction inside a comment or string (ac-3)", () => {
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-3`); // scope ac-3: comments/strings must not trip the scan
    const lineComment = "// historically this did `new Anthropic({apiKey})`\n";
    const blockComment = "/* never do new Anthropic({}) here */\n";
    const stringMention = 'const msg = "do not call new Anthropic( directly";\n';
    expect(findDirectAnthropicConstructions(lineComment)).toEqual([]);
    expect(findDirectAnthropicConstructions(blockComment)).toEqual([]);
    expect(findDirectAnthropicConstructions(stringMention)).toEqual([]);
  });

  it("does NOT flag longer identifiers (AnthropicLike / AnthropicBedrock)", () => {
    tagAc(`${AC}/ac-2`);
    expect(findDirectAnthropicConstructions("new AnthropicLike({})")).toEqual(
      [],
    );
    expect(
      findDirectAnthropicConstructions("new AnthropicBedrock({})"),
    ).toEqual([]);
  });
});
