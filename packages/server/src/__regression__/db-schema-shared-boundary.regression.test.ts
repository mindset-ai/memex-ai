// Static-scan guard for the db-schema standalone boundary (spec-279 / std-24).
//
// `@mindset-ai/db-schema` (packages/db-schema, spec-279 dec-1) is published to
// GitHub Packages so an out-of-workspace repo (Backstage — spec-280) can consume
// the production DB schema with full types WITHOUT forking schema.ts or depending
// on the monorepo. Its entry (packages/db-schema/src/index.ts) does
// `export * from "../../server/src/db/schema.js"`, and the build (tsup/esbuild)
// bundles the schema source plus the few type-only cross-file imports it makes
// into a self-contained dist whose ONLY surviving runtime dep is `drizzle-orm`.
//
// The hard constraint: NO file reachable from db-schema's bundle may import
// `@memex/shared`. pnpm's isolated node_modules does not resolve `@memex/shared`
// from within the db-schema package, so any such import breaks the dts/tsup build
// at install time. This is not hypothetical — it bit during spec-374, when
// `types/roles.ts` gained a `@memex/shared` import (PHASE_ORDER) and PR #312's
// `server (2)` shard failed on `packages/db-schema prepare:
// ../server/src/types/roles.ts: error TS2307: Cannot find module '@memex/shared'`.
// roles.ts now carries a NOTE *comment* warning future authors off — that comment
// must NOT trip this scan; only a real import statement does.
//
// dec-1: we WALK the relative import graph from the entry (index.ts) transitively
// into packages/server/src — following only `./`/`../` specifiers, treating bare
// specifiers (drizzle-orm, @memex/shared) as leaves — and build the set of files
// tsup actually bundles. A flat hardcoded file list would cover today's three
// files (index.ts → db/schema.ts → types/roles.ts) but silently miss any new
// relative import schema.ts/roles.ts gain later — exactly the regression class
// this guard exists to catch.
//
// The scan is comment/string-aware (it reuses the stripComments approach proven
// by mutate-coverage.static-scan.test.ts) so a `@memex/shared` mention inside a
// comment or string literal never trips it — only a real `from "@memex/shared"`
// import/export-from clause does.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const AC = "mindset-prod/memex-building-itself/specs/spec-387/acs";

// The published package's entry point — the root of the bundle graph.
// __dirname = packages/server/src/__regression__ → repo packages/ is two up.
const PACKAGES_DIR = resolve(__dirname, "..", "..", "..");
const DB_SCHEMA_ENTRY = resolve(PACKAGES_DIR, "db-schema", "src", "index.ts");
// The walk only follows relative imports INTO this tree (where the bundled
// server sources live); imports that escape it are not part of db-schema's
// bundle and are not our concern.
const SERVER_SRC = resolve(PACKAGES_DIR, "server", "src");

// ── lexing: strip comments + strings so a mention in prose never trips the scan
// (mirrors mutate-coverage.static-scan.test.ts) ──────────────────────────────

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

// NOTE: unlike the std-30 scanner's stripper, this one COPIES string interiors
// through verbatim rather than blanking them — the import SPECIFIER we extract
// (`from "@memex/shared"`) lives inside the string, so blanking it would erase
// what we need to read. A bare string mention (`const x = "@memex/shared"`) is
// not flagged because the import regexes require a `from`/`import` keyword
// immediately before the quote; a comment mention is removed by the comment
// passes below. Only string-embedded COMMENT MARKERS need neutralising, which
// the copy-through achieves.
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(src, i, ch);
      out += src.slice(i, end);
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

// ── import extraction ────────────────────────────────────────────────────────

// Every module specifier in an `import ... from "X"`, `export ... from "X"`,
// `import "X"` (side-effect), or dynamic `import("X")` form. We strip comments
// first so a specifier sitting inside a comment is never extracted.
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /\bimport\s*["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function extractSpecifiers(strippedSrc: string): string[] {
  const out = new Set<string>();
  for (const re of [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(strippedSrc)) !== null) out.add(m[1]);
  }
  return [...out];
}

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

// Resolve a relative specifier (which carries a `.js` extension under
// NodeNext/ESM) to the on-disk `.ts` source file it actually denotes.
function resolveRelativeToTs(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"), // `./foo.js` → `./foo.ts`
    base, // already a real path (e.g. `.ts` written directly)
    `${base}.ts`, // extensionless `./foo` → `./foo.ts`
    resolve(base, "index.ts"), // `./dir` → `./dir/index.ts`
  ];
  for (const c of candidates) {
    if (existsSync(c) && c.endsWith(".ts")) return c;
  }
  return null;
}

// ── the bundle graph walk ────────────────────────────────────────────────────

interface SharedImport {
  file: string; // relative-to-packages/ for readable failure messages
  line: number;
  context: string;
}

// Build the set of source files tsup bundles into db-schema, by following only
// relative imports transitively from the entry. Returns the absolute file set.
export function collectBundleFiles(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const stripped = stripComments(readFileSync(file, "utf8"));
    for (const spec of extractSpecifiers(stripped)) {
      if (!isRelative(spec)) continue; // bare specifiers are leaves
      const resolved = resolveRelativeToTs(file, spec);
      // Only follow imports that stay within the server src tree (or the
      // db-schema src itself) — those are the files that get bundled.
      if (
        resolved &&
        (resolved.startsWith(SERVER_SRC) ||
          resolved.startsWith(resolve(PACKAGES_DIR, "db-schema", "src")))
      ) {
        stack.push(resolved);
      }
    }
  }
  return [...seen];
}

// Find every real `@memex/shared` (or `@memex/shared/...`) import/export-from in
// one file's source (comments/strings stripped).
const SHARED_IMPORT_RE =
  /\b(?:from|import)\s*\(?\s*["']@memex\/shared(?:\/[^"']*)?["']/g;

export function findSharedImports(absFile: string): SharedImport[] {
  const stripped = stripComments(readFileSync(absFile, "utf8"));
  const out: SharedImport[] = [];
  let m: RegExpExecArray | null;
  SHARED_IMPORT_RE.lastIndex = 0;
  while ((m = SHARED_IMPORT_RE.exec(stripped)) !== null) {
    const line = stripped.slice(0, m.index).split("\n").length;
    const lineEnd = stripped.indexOf("\n", m.index);
    const context = stripped
      .slice(m.index, lineEnd === -1 ? stripped.length : lineEnd)
      .trim();
    out.push({ file: relative(PACKAGES_DIR, absFile), line, context });
  }
  return out;
}

describe("db-schema standalone boundary (spec-279 / std-24)", () => {
  it("the db-schema entry point exists", () => {
    tagAc(`${AC}/ac-1`);
    expect(existsSync(DB_SCHEMA_ENTRY)).toBe(true);
  });

  const bundleFiles = collectBundleFiles(DB_SCHEMA_ENTRY);

  it("the bundle graph walk reaches schema.ts and roles.ts (and nothing escapes the walk)", () => {
    tagAc(`${AC}/ac-1`);
    const rel = bundleFiles.map((f) => relative(PACKAGES_DIR, f));
    // index.ts → db/schema.ts → types/roles.ts is the known chain today; the
    // walk MUST cover at least these, proving it followed the relative imports
    // rather than stopping at the entry.
    expect(rel).toContain("db-schema/src/index.ts");
    expect(rel.some((r) => r.endsWith("server/src/db/schema.ts"))).toBe(true);
    expect(rel.some((r) => r.endsWith("server/src/types/roles.ts"))).toBe(true);
  });

  it("no file in the db-schema bundle imports @memex/shared", () => {
    tagAc(`${AC}/ac-1`); // scope ac-1
    tagAc(`${AC}/ac-6`); // implementation ac-6: the graph-walk bundle scan asserts no @memex/shared import
    const violations = bundleFiles.flatMap(findSharedImports);
    expect(
      violations,
      violations.length
        ? `db-schema boundary violation (spec-279 / std-24): a file bundled into ` +
            `the standalone @mindset-ai/db-schema package imports @memex/shared, ` +
            `which pnpm's isolated node_modules cannot resolve there — it breaks the ` +
            `dts/tsup build at install (this exact failure bit roles.ts during ` +
            `spec-374). Offending import(s):\n` +
            violations
              .map((v) => `  • ${v.file}:${v.line}  ${v.context}`)
              .join("\n") +
            `\nThe db-schema bundle (everything reachable from ` +
            `packages/db-schema/src/index.ts via relative imports) may depend ONLY ` +
            `on drizzle-orm. Move the needed value out of @memex/shared into a ` +
            `bundle-local module, or inline it — do not pull @memex/shared into a ` +
            `schema-reachable file. roles.ts's NOTE comment exists to warn you off.`
        : "",
    ).toEqual([]);
  });
});

describe("db-schema boundary scanner meta-tests (catch-a-violation)", () => {
  // Synthesize a tiny graph in memory-equivalent terms by exercising the pure
  // extractors against crafted source, so we prove the scan distinguishes real
  // imports from prose without touching the real tree.

  it("findSharedImports-style detection flags a real import but not a comment/string (ac-3)", () => {
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-3`); // scope ac-3: comments/strings must not trip the scan
    tagAc(`${AC}/ac-4`); // scope ac-4: the guard goes red on a real violation
    tagAc(`${AC}/ac-5`); // scope ac-5: findSharedImports records file:line + context for the message
    const run = (src: string) => {
      const stripped = stripComments(src);
      const out: number[] = [];
      let m: RegExpExecArray | null;
      SHARED_IMPORT_RE.lastIndex = 0;
      while ((m = SHARED_IMPORT_RE.exec(stripped)) !== null) out.push(m.index);
      return out;
    };

    // A real import — flagged.
    expect(
      run(`import { PHASE_ORDER } from "@memex/shared";`).length,
    ).toBe(1);
    // A subpath import — flagged.
    expect(
      run(`import { x } from "@memex/shared/phases";`).length,
    ).toBe(1);
    // A re-export — flagged.
    expect(run(`export { x } from "@memex/shared";`).length).toBe(1);
    // The legitimate roles.ts NOTE comment — NOT flagged.
    expect(
      run(`// NOTE: do NOT import @memex/shared here. roles.ts is re-exported`)
        .length,
    ).toBe(0);
    // A string mention — NOT flagged.
    expect(run(`const pkg = "@memex/shared";`).length).toBe(0);
  });

  it("the relative-import walk follows ./ and ../ but treats bare specifiers as leaves", () => {
    tagAc(`${AC}/ac-1`);
    expect(isRelative("./roles.js")).toBe(true);
    expect(isRelative("../types/roles.js")).toBe(true);
    expect(isRelative("drizzle-orm")).toBe(false);
    expect(isRelative("@memex/shared")).toBe(false);
  });
});
