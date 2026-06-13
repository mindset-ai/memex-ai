import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// spec-279 t-1 — the standalone @mindset-ai/db-schema package.
//
// These tests verify the PUBLISHED shape, not just the source: they build a
// real tarball with `npm pack` (which runs the `prepare`/tsup build) and prove
// it is self-contained and installable outside the workspace.

const PKG_DIR = resolve(__dirname, "..");
const DIST_JS = join(PKG_DIR, "dist", "index.js");
const DIST_DTS = join(PKG_DIR, "dist", "index.d.ts");
const pkgJson = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

// A single packed tarball shared across the install-shaped assertions.
let tarballPath: string;

beforeAll(() => {
  // Build a fresh dist first, then pack with --ignore-scripts so the tsup build
  // logs don't pollute the --json stdout we parse for the produced filename.
  execFileSync("pnpm", ["build"], { cwd: PKG_DIR, stdio: "ignore" });
  const out = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], { cwd: PKG_DIR, encoding: "utf8" });
  const filename = JSON.parse(out)[0].filename;
  tarballPath = join(PKG_DIR, filename);
  expect(existsSync(tarballPath), `tarball ${filename} should exist`).toBe(true);
}, 120_000);

describe("ac-7 — built from schema.ts (single source), exports tables + inferred types as ESM + d.ts", () => {
  it("re-exports the single source (no second schema copy) and emits ESM + d.ts", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-7");

    // Single source: src/index.ts re-exports the server schema, it does not copy it.
    const srcIndex = readFileSync(join(PKG_DIR, "src", "index.ts"), "utf8");
    expect(srcIndex).toMatch(/export \* from "\.\.\/\.\.\/server\/src\/db\/schema\.js"/);

    // ESM js + a declaration file are both emitted.
    expect(existsSync(DIST_JS), "dist/index.js emitted").toBe(true);
    expect(existsSync(DIST_DTS), "dist/index.d.ts emitted").toBe(true);

    // The built module exports the Drizzle table objects.
    const mod = await import(pathToFileURL(DIST_JS).href);
    for (const table of ["documents", "acs", "tasks", "decisions", "testEvents"]) {
      expect(mod[table], `table export ${table}`).toBeDefined();
    }

    // The d.ts carries the inferred row/insert types derived from those tables.
    const dts = readFileSync(DIST_DTS, "utf8");
    expect(dts).toMatch(/type Doc\b/);
    expect(dts).toMatch(/InferSelectModel|InferInsertModel/);
  });
});

describe("ac-1 / ac-6 — self-contained: zero workspace/@memex deps, installs in an empty project", () => {
  it("declares no workspace:* or @memex/* dependency, and the built js imports only drizzle-orm", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-1");

    // No workspace/@memex deps in anything a consumer would resolve.
    for (const field of ["dependencies", "peerDependencies"] as const) {
      const deps: Record<string, string> = pkgJson[field] ?? {};
      for (const [name, range] of Object.entries(deps)) {
        expect(name.startsWith("@memex/"), `${field} key ${name}`).toBe(false);
        expect(String(range).includes("workspace:"), `${field} ${name} range`).toBe(false);
      }
    }
    // The only runtime dependency is drizzle-orm.
    expect(Object.keys(pkgJson.dependencies ?? {})).toEqual(["drizzle-orm"]);

    // The bundled js must import nothing but drizzle-orm — the schema source is inlined.
    const js = readFileSync(DIST_JS, "utf8");
    const specifiers = [...js.matchAll(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec.startsWith("drizzle-orm"), `import specifier ${spec}`).toBe(true);
    }
  });

  it("installs into a fresh empty project and the package resolves by name", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-6");

    const proj = mkdtempSync(join(tmpdir(), "db-schema-consumer-"));
    try {
      // A bare project with no monorepo around it.
      execFileSync("npm", ["init", "-y"], { cwd: proj, stdio: "ignore" });
      // Install the packed tarball; drizzle-orm resolves from the public registry.
      execFileSync("npm", ["install", tarballPath], { cwd: proj, stdio: "ignore" });

      const installed = join(proj, "node_modules", "@mindset-ai", "db-schema", "dist", "index.js");
      expect(existsSync(installed), "package installed into node_modules").toBe(true);
      expect(existsSync(join(proj, "node_modules", "drizzle-orm")), "drizzle-orm dep resolved").toBe(true);

      // It imports cleanly by name from inside the empty project.
      const probe = `import('@mindset-ai/db-schema').then(m => { if (!m.documents) { process.exit(7); } process.stdout.write('OK'); }).catch(e => { console.error(e); process.exit(8); });`;
      const result = execFileSync("node", ["-e", probe], { cwd: proj, encoding: "utf8" });
      expect(result).toContain("OK");
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

describe("ac-4 — no external/OSS user must authenticate to a registry to build the repo", () => {
  it("the published artifact is outbound-only: no workspace package depends on @mindset-ai/*", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-279/acs/ac-4");

    // The new package is consumed ONLY by the out-of-repo Backstage app. Building
    // THIS repo from source must never require pulling an @mindset-ai/* package
    // from a registry — so nothing in the workspace may depend on one.
    const packagesDir = resolve(__dirname, "..", "..");
    const offenders: string[] = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(packagesDir, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
        for (const dep of Object.keys(manifest[field] ?? {})) {
          if (dep.startsWith("@mindset-ai/")) offenders.push(`${entry.name}:${field}:${dep}`);
        }
      }
    }
    expect(offenders, "no workspace package may depend on @mindset-ai/*").toEqual([]);

    // And the db-schema package itself pulls nothing from the workspace.
    for (const field of ["dependencies", "peerDependencies"] as const) {
      for (const range of Object.values((pkgJson[field] ?? {}) as Record<string, string>)) {
        expect(String(range).includes("workspace:")).toBe(false);
      }
    }
  });
});

// Housekeeping: remove the tarball(s) this suite produced so the package dir
// stays clean (and they never accidentally get committed).
import { afterAll } from "vitest";
afterAll(() => {
  for (const f of readdirSync(PKG_DIR)) {
    if (f.startsWith("mindset-ai-db-schema-") && f.endsWith(".tgz")) {
      rmSync(join(PKG_DIR, f), { force: true });
    }
  }
});
