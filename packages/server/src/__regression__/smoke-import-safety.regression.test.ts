// Every smoke file must survive being IMPORTED with no database.
//
// WHY THIS EXISTS. The smoke suite hits a remote deployed host over plain HTTP. It has
// no DATABASE_URL, and `db/connection.ts` throws at MODULE LOAD without one. So a smoke
// file that transitively imports it dies before a single assertion — or a skip guard —
// can run. The failure looks like a broken deployment and is not one.
//
// THIS HAS NOW HAPPENED THREE TIMES:
//   · twice in spec-515, documented in memex-resolver.ts's re-export note, which is why
//     TENANT_EXEMPT_HEADER was moved into the zero-import routes/api-roots.ts;
//   · once on 2026-08-14 (spec-525 t-9), when the new gate smoke imported the admission
//     MIDDLEWARE to get a header name. The middleware reaches db/connection through
//     routes/test-events.js. The int deploy went red with "DATABASE_URL environment
//     variable is required" while traffic was already live.
//
// A comment in one file did not stop the third occurrence — the author had read it. So
// this is a check instead. It fails in CI, before a deploy is wasted proving it.
//
// WHAT IT DOES. Walks each smoke file's relative imports transitively and fails if any
// path reaches db/connection. Static, so it costs nothing and needs no database itself.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SRC = join(__dirname, "..");
const SMOKE_DIR = join(SRC, "__smoke__");

/** Resolve a relative `.js` specifier back to the `.ts` file it is written from. */
function resolveTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package import — cannot reach our db layer
  const abs = resolve(dirname(fromFile), spec.replace(/\.js$/, ".ts"));
  try {
    readFileSync(abs, "utf-8");
    return abs;
  } catch {
    return null; // a directory index or a type-only path we cannot resolve; not a risk
  }
}

/** Every relative import in a file, as absolute .ts paths. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf-8");
  const specs = [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
  return specs.map((s) => resolveTs(file, s)).filter((p): p is string => p !== null);
}

/** The import chain from `file` to db/connection, or null if there is none. */
function pathToDbConnection(file: string, seen = new Set<string>()): string[] | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const dep of importsOf(file)) {
    if (dep.endsWith(join("db", "connection.ts"))) return [file, dep];
    const deeper = pathToDbConnection(dep, seen);
    if (deeper) return [file, ...deeper];
  }
  return null;
}

const SMOKE_FILES = readdirSync(SMOKE_DIR)
  .filter((f) => f.endsWith(".smoke.test.ts"))
  .map((f) => join(SMOKE_DIR, f));

describe("smoke files import nothing that demands a database", () => {
  it("finds the smoke files at all — an empty loop would report safety it never checked", () => {
    expect(SMOKE_FILES.length).toBeGreaterThan(5);
  });

  it.each(SMOKE_FILES.map((f) => [f.slice(SRC.length + 1), f]))(
    "%s does not reach db/connection",
    (_label, file) => {
      const chain = pathToDbConnection(file);
      expect(
        chain === null ? null : chain.map((p) => p.slice(SRC.length + 1)).join("\n  -> "),
        "this smoke file dies on import against a deployed host, because db/connection " +
          "throws at module load without DATABASE_URL. Import the NAME from a module " +
          "that stays import-free (routes/api-roots.ts, services/admission/" +
          "emission-gate.ts) rather than from the file that uses it. Chain:",
      ).toBeNull();
    },
  );
});
