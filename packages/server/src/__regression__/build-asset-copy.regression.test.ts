// Build-script asset-copy guard.
//
// `tsc` only emits .js — it ignores non-TS files. So every directory under
// `src/` that holds runtime assets (.md, .json, etc.) needs an explicit
// `cp` step in the package.json `build` script, otherwise the prod container
// runs with files missing and tools that read them throw ENOENT at runtime.
//
// We learned this the expensive way: the `guidance/` directory was added for
// the get_information MCP tool but never wired into the build script. Local
// dev ran fine (paths resolve relative to src/), int Cloud Run blew up the
// first time the tool was called. The telemetry table caught it as a friction
// row — exactly what telemetry is for — but the asymmetry between dev (works)
// and prod (broken) is the kind of thing that should fail before deploy, not
// after.
//
// This test walks src/ for any directory containing files with non-source
// extensions and asserts each such directory has a corresponding copy step
// in the build script. New asset dirs are caught the first time you commit
// them, not the first time someone calls a tool that needs them.
//
// Allowlisted source-only extensions: .ts (compiled by tsc), .test.ts (not
// in dist anyway).

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(__dirname, "..");
const PKG_JSON = join(__dirname, "..", "..", "package.json");

// Extensions that tsc handles natively — no copy step needed.
const COMPILED_EXTENSIONS = new Set([".ts", ".tsx"]);

// Paths that don't ship in the runtime image even if they contain non-TS
// files (test fixtures, ad-hoc dev assets). Keep small; if you're tempted
// to add a path here, ask whether the file SHOULD be in dist instead.
const RUNTIME_EXCLUDED_PREFIXES = [
  "__test__",
  "__e2e__",
  "__perf__",
  "__regression__",
  "__security__",
  "__smoke__",
];

// Directories whose non-TS files are loaded via TS module imports
// (e.g. `import data from "./foo.json" with { type: "json" }`). tsc inlines
// the import into the .js output, so no separate copy step is needed.
// Keep this list tight: every entry needs a one-line justification, and the
// reason should be checked when files are added to the directory (a future
// .md/.html file would NOT ride along on the import path).
const TS_IMPORT_ONLY_DIRS: Record<string, string> = {
  "services/email":
    "free-domains.json is loaded via `import ... with { type: 'json' }` in services/free-email-domains.ts — tsc compiles it into the .js output.",
};

function listAssetDirsUnder(dir: string): Set<string> {
  const found = new Set<string>();
  walk(dir, found);
  return found;
}

function walk(dir: string, found: Set<string>): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, found);
      continue;
    }
    const dot = entry.lastIndexOf(".");
    const ext = dot >= 0 ? entry.slice(dot) : "";
    if (COMPILED_EXTENSIONS.has(ext)) continue;
    // Skip dotfiles, snapshot/coverage debris.
    if (entry.startsWith(".") || entry.endsWith(".snap")) continue;
    const relDir = relative(SRC_DIR, dir);
    if (RUNTIME_EXCLUDED_PREFIXES.some((p) => relDir.startsWith(p))) continue;
    found.add(relDir);
  }
}

describe("build script copies every src/ asset directory into dist/", () => {
  it("every directory containing non-TS runtime files appears in the build script", () => {
    const pkg = JSON.parse(readFileSync(PKG_JSON, "utf-8"));
    const buildScript = pkg.scripts?.build ?? "";
    const assetDirs = listAssetDirsUnder(SRC_DIR);

    // Collect every dir that has a recursive copy step — `cp -R src/<X>/.`
    // covers all descendants of <X>. Without this, the test would flag every
    // subdir of agent/phases/* (which IS covered by `cp -R src/agent/phases/.`).
    const recursiveCopyRoots = new Set<string>();
    for (const m of buildScript.matchAll(/cp\s+-R\s+src\/([^\s]+?)\/\./g)) {
      recursiveCopyRoots.add(m[1]);
    }
    const coveredByRecursive = (dir: string): boolean => {
      for (const root of recursiveCopyRoots) {
        if (dir === root || dir.startsWith(`${root}/`)) return true;
      }
      return false;
    };

    const missing: string[] = [];
    for (const dir of assetDirs) {
      if (dir in TS_IMPORT_ONLY_DIRS) continue;
      if (coveredByRecursive(dir)) continue;
      // Direct copy form: `cp src/<dir>/...` (literal substring match).
      const needle = `src/${dir}/`;
      if (!buildScript.includes(needle)) {
        missing.push(dir);
      }
    }

    expect(missing, [
      "Asset directories under src/ that the build script doesn't copy to",
      "dist/. tsc only emits .js, so non-TS files (.md, .json, etc.) ship",
      "only if the build script explicitly copies them. The container will",
      "ENOENT at runtime the first time a code path reads from these dirs.",
      "",
      "Add a copy step to packages/server/package.json `build` for each:",
      ...missing.map((d) => `  mkdir -p dist/${d} && cp src/${d}/* dist/${d}/`),
    ].join("\n")).toEqual([]);
  });
});
