#!/usr/bin/env node
// POST-PUBLISH verification — proves the version on the REGISTRY is importable.
//
//   node scripts/verify-published-artifact.mjs            # whatever dist-tags.latest serves
//   node scripts/verify-published-artifact.mjs 0.3.1      # a specific version
//
// Run this after every publish. It is the package-level sibling of the live smoke
// run we do after every deploy: same idea, same reason — the only artifact whose
// identity with what users get is beyond doubt is the one the server hands out.
//
// WHY THIS EXISTS, and why it is separate from verify-publish-artifact.mjs (note the
// one-word difference: publiSH = pre-publish gate, publiSHED = this).
//
// 0.3.0 shipped on 2026-08-10 unimportable by any external Vite/Vitest consumer. The
// pre-publish gate was present, wired into prepublishOnly, and it PASSED — verified
// by re-running it on de0aff2b, the exact commit that cut 0.3.0: exit 0, green. It
// was not skipped and it was not weak. It packs with `pnpm pack`; the publish was
// performed with `npm publish`, which ignores the `publishConfig.exports` override
// that strips the workspace-only `development -> ./src` condition. Two packers, two
// tarballs, and the gate inspected the one that never left the laptop.
//
// The tarball's CONTENTS were also verified that day, by hand, and were correct.
// What nobody checked was whether the package could be RESOLVED. A local pack cannot
// answer that: this repo reaches the package through a workspace symlink where ./src
// genuinely exists, so the fault is invisible from inside the repo by construction.
//
// The gate now refuses a non-pnpm publisher outright, which closes the specific hole.
// This script closes the general one: it does not trust any local artifact, any
// packer, or any assumption about who published. It asks npm.
//
// Deliberately NOT a vitest test — it needs the network and a real `npm install`, so
// in the unit suite it would break the offline check battery and tie CI to npm's
// availability. It is a post-publish action, like a smoke run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).name;
const SPEC = process.argv[2] ?? "latest";

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// Every string leaf of an exports map, recursing through condition objects.
const leaves = (node, out = []) => {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) leaves(v, out);
  return out;
};

const failures = [];

// A spawned node failure arrives as a multi-line "Command failed: <the whole -e
// script>\n<stack>". Reduce it to the line a reader needs — the thrown Error — so the
// final summary stays legible; the full stderr is already printed above it.
const gist = (message) => {
  const line =
    message.split("\n").find((l) => /^\s*(Error|[A-Za-z]*Error)\b/.test(l)) ??
    message.split("\n")[0];
  return line.trim().slice(0, 300);
};

const check = (label, fn) => {
  try {
    const detail = fn();
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    // Report every failure rather than stopping at the first: when a publish goes
    // wrong the useful output is the whole shape of the wrongness, not its first symptom.
    failures.push(`${label}: ${gist(e.message)}`);
    console.error(`  ✗ ${label} — ${gist(e.message)}`);
    if (e.stderr) console.error(String(e.stderr).trimEnd().split("\n").slice(0, 6).join("\n"));
  }
};

console.log(`\nverifying ${NAME}@${SPEC} as served by the registry\n`);
const tmp = mkdtempSync(join(tmpdir(), "ac-emit-published-"));

try {
  // Install into an EMPTY directory, so nothing in this workspace can satisfy the
  // import. --no-package-lock keeps the temp dir disposable; no cache flag is passed
  // because the version-identity check below is what catches a stale resolution.
  const consumer = join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "published-probe", private: true, type: "module", version: "1.0.0" }) + "\n",
  );
  console.log(`• installing from the registry into a clean directory`);
  sh("npm", ["install", "--no-fund", "--no-audit", "--no-package-lock", `${NAME}@${SPEC}`], {
    cwd: consumer,
  });

  const installedRoot = join(consumer, "node_modules", ...NAME.split("/"));
  const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
  console.log(`• installed ${manifest.name}@${manifest.version}\n`);

  check("resolves to a concrete version", () => {
    if (!manifest.version) throw new Error("installed manifest carries no version");
    if (SPEC !== "latest" && manifest.version !== SPEC) {
      throw new Error(`asked for ${SPEC}, npm installed ${manifest.version} (stale cache?)`);
    }
    return manifest.version;
  });

  // THE 0.3.0 CHECK. Every exports target must be a file the tarball actually ships.
  // This also covers ./setup, which cannot be import-probed: dist/setup.js calls
  // vitest's beforeEach at module scope, so under bare node it throws from inside
  // @vitest/runner ("failed to find the runner") — resolution succeeded, execution
  // can't. Existence is the honest check for a subpath like that.
  check("every exports target is a file that was actually shipped", () => {
    const targets = leaves(manifest.exports ?? {});
    if (!targets.length) throw new Error("published manifest declares no exports");
    const missing = targets.filter((t) => !existsSync(join(installedRoot, t.replace(/^\.\//, ""))));
    if (missing.length) throw new Error(`exports point at absent files: ${missing.join(", ")}`);
    return `${targets.length} targets`;
  });

  // Names the ONE condition that must never ship, rather than counting conditions.
  // An earlier draft asserted "exactly two leaves per entry point", which is an
  // incidental fact about today's manifest, not an invariant: adding `require` for a
  // CJS dual-publish, or `browser` for the jsdom consumers ac-4 is about, would red a
  // perfectly good release. Constraining shapes we have not seen yet is the same
  // reflex ac-10 forbids — and the leaf-existence check above already catches any
  // leaked condition, named or not, because its target would be absent from the tarball.
  check("no workspace-only `development` condition survived into the published exports", () => {
    const keys = (node, out = []) => {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        for (const [k, v] of Object.entries(node)) {
          if (!k.startsWith(".")) out.push(k);
          keys(v, out);
        }
      }
      return out;
    };
    const json = JSON.stringify(manifest.exports ?? {});
    if (json.includes("/src")) throw new Error(`exports still reference ./src — ${json}`);
    if (keys(manifest.exports ?? {}).includes("development")) {
      throw new Error(`published exports still carry a \`development\` condition — ${json}`);
    }
  });

  // THE CHECK THAT MATTERS MOST. --conditions=development reproduces Vite's and
  // Vitest's resolver, which is the ONLY resolver that ever saw the 0.3.0 fault.
  // Without this flag the probe passes on a broken package — a probe that reports
  // success on the exact defect it exists to catch is worse than no probe at all.
  const probe = [
    'import { deriveEventsUrl, tagAc } from "PKG";',
    'if (typeof tagAc !== "function") { console.error("tagAc is not callable"); process.exit(3); }',
    'const u = deriveEventsUrl("a-customer/mx/specs/spec-1/acs/ac-1");',
    'if (u !== "https://memex.ai/api/test-events") { console.error("routing wrong: " + u); process.exit(4); }',
    'process.stdout.write(u);',
  ]
    .join("\n")
    .replace("PKG", NAME);

  check("imports under --conditions=development (the Vite/Vitest resolver)", () =>
    sh("node", ["--conditions=development", "--input-type=module", "-e", probe], { cwd: consumer }).trim(),
  );

  check("imports under plain node (no extra conditions)", () =>
    sh("node", ["--input-type=module", "-e", probe], { cwd: consumer }).trim(),
  );

  // ac-9 — the identity the escape broke. Comparing two local packs cannot establish
  // it; one side of the comparison has to be what npm serves.
  check("the registry's exports are byte-identical to what `pnpm pack` produces here", () => {
    const packDir = join(tmp, "pack");
    mkdirSync(packDir);
    sh("pnpm", ["pack", "--pack-destination", packDir], { cwd: pkgDir });
    const tgz = sh("ls", [packDir]).trim().split("\n").find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("pnpm pack produced no tarball");
    const x = join(packDir, "x");
    mkdirSync(x);
    sh("tar", ["-xzf", join(packDir, tgz), "-C", x]);
    const local = JSON.parse(readFileSync(join(x, "package", "package.json"), "utf8"));
    const a = JSON.stringify(local.exports);
    const b = JSON.stringify(manifest.exports);
    if (a !== b) throw new Error(`local pack ${a} !== registry ${b}`);
    if (local.version !== manifest.version) {
      // Not a failure of the identity itself — say so precisely rather than implying
      // the exports diverged. Comparing an unbumped working tree to the last release
      // is the normal case when this runs mid-development.
      return `exports match (note: local tree is ${local.version}, registry ${manifest.version})`;
    }
    return "exports match";
  });
} catch (e) {
  failures.push(`setup: ${e.message}`);
  console.error(`\n✗ could not complete verification`);
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
  console.error(e.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n✗ ${NAME}@${SPEC} FAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`    - ${f}`);
  console.error(`\n  A published version that cannot be imported must be superseded, not patched:`);
  console.error(`  bump the patch version, \`pnpm publish\` (never npm — see verify-publish-artifact.mjs),`);
  console.error(`  then \`npm deprecate ${NAME}@<broken> "<what to use instead>"\`. Do NOT unpublish:`);
  console.error(`  consumers already locked to it would lose the dependency entirely, npm refuses to`);
  console.error(`  reuse a yanked version number, and deprecation is reversible where an unpublish is not.`);
  process.exit(1);
}

console.log(`\n✓ ${NAME}@${SPEC} installs and imports cleanly from the registry`);
console.log(`  (node lane only — a browser-like/jsdom consumer is verified by its own suite)\n`);
