#!/usr/bin/env node
// Pre-publish gate (wired into `prepublishOnly`).
//
// Packs the REAL publishable tarball with `pnpm pack` (so publishConfig field
// overrides — e.g. the dist-only `exports` — are applied, exactly as on publish)
// and proves it is consumable. Aborts the publish (exit 1) if not.
//
// Why this exists: the in-repo test suite resolves `@memex-ai-ac/vitest` against
// on-disk `src` via the `development` export condition, so it CANNOT see a
// packaging fault where the published `exports` point at files that aren't
// shipped. spec-90: a `development -> ./src/index.ts` condition leaked into the
// published artifact; `src/` isn't in `files`, so every external Vitest consumer
// got "Failed to resolve entry for package". Caught only by packing the tarball
// and importing it as a consumer. This gate makes that check automatic.
//
// Two checks:
//   1. STATIC  — every leaf target in the tarball's `exports` is a shipped file.
//   2. DYNAMIC — install the tarball and import "." under the `development`
//                condition (what Vite/Vitest set); assert B1 routing. A leaked
//                dev->src condition throws here.
//
// No vitest install, no secrets, ~1-2s (the package has zero runtime deps).

import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// Collect every string leaf in an exports map (recurses through condition objects).
const leaves = (node, out = []) => {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) leaves(v, out);
  return out;
};

const tmp = mkdtempSync(join(tmpdir(), "ac-emit-verify-"));
let failed = false;
try {
  // 1. Pack the real publishable artifact. `pnpm pack` applies publishConfig
  //    overrides; it triggers prepack/prepare (tsc) but never prepublishOnly,
  //    so calling it from within prepublishOnly cannot recurse.
  sh("pnpm", ["pack", "--pack-destination", tmp], { cwd: pkgDir });
  const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("pnpm pack produced no tarball");
  const tgzPath = join(tmp, tgz);

  // --- STATIC: exports targets must be shipped files ---
  const extract = join(tmp, "x");
  mkdirSync(extract);
  sh("tar", ["-xzf", tgzPath, "-C", extract]);
  const root = join(extract, "package");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const targets = leaves(manifest.exports ?? {});
  const missing = targets.filter((t) => !existsSync(join(root, t.replace(/^\.\//, ""))));
  if (missing.length) {
    throw new Error(
      `published exports reference files NOT in the tarball: ${missing.join(", ")}\n` +
        `(shipped 'files': ${JSON.stringify(manifest.files)})`,
    );
  }
  if (JSON.stringify(manifest.exports).includes("/src")) {
    throw new Error("published exports still reference ./src — workspace-only condition leaked");
  }

  // --- DYNAMIC: a real consumer imports it under the development condition ---
  const cons = join(tmp, "consumer");
  mkdirSync(cons);
  writeFileSync(
    join(cons, "package.json"),
    JSON.stringify({ name: "verify-consumer", private: true, type: "module", version: "1.0.0" }) + "\n",
  );
  sh("npm", ["install", "--no-fund", "--no-audit", "--no-package-lock", tgzPath], { cwd: cons });
  const probe = [
    'import { deriveEventsUrl } from "@memex-ai-ac/vitest";',
    'const u = deriveEventsUrl("a-customer/mx/specs/spec-1/acs/ac-1");',
    'if (u !== "https://memex.ai/api/test-events") { console.error("B1 routing wrong:", u); process.exit(3); }',
    'console.log("  import OK (development condition); B1 routing ->", u);',
  ].join("\n");
  // --conditions=development reproduces Vite/Vitest's resolver, where the bug lived.
  process.stdout.write(
    sh("node", ["--conditions=development", "--input-type=module", "-e", probe], { cwd: cons }),
  );

  console.log("✓ publish-artifact verification passed");
} catch (e) {
  failed = true;
  console.error("✗ publish-artifact verification FAILED — aborting publish\n");
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  console.error(e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
