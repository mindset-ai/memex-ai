// spec-509 dec-2 / dec-3 / dec-4 (ac-14 / ac-16 / ac-20) — the provisioned starter Spec
// is GONE from the codebase.
//
// The seeded "Understanding Memex" Spec measured, on prod 2026-07-25, at 4 opens across
// 110 new external users with zero owner edits, comments, or version bumps across all 240
// copies ever seeded. dec-2 deleted the seeder and its content fixture outright rather
// than gating them behind an env var, precisely so the seed cannot come back by accident;
// this scan is the mechanism that makes "cannot come back" true rather than aspirational.
//
// A green typecheck already proves no source file imports a deleted SYMBOL (a dangling
// import wouldn't compile). This static scan is the belt-and-suspenders guard: it fails
// loudly if a deleted MODULE is re-created or re-imported, if the retired env-var gate
// reappears, or if the test surface regrows a starter-seeding endpoint. It follows the
// spec-474 handhold-demo scan (the sibling removal) file-for-file.
//
// Deliberately NOT asserted here: that provisioning seeds no Spec at runtime. A static
// scan cannot prove behaviour — that is provisioning-dec6.test.ts against real Postgres
// (ac-13). This file guards the code's SHAPE; that one guards what it DOES.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-509/acs/ac-${n}`;

const SERVER_SRC = join(__dirname, "..");
const UI_SRC = join(__dirname, "../../../ui/src");
const REPO_ROOT = join(__dirname, "../../../..");

// Every file the removal deleted, keyed by repo-relative path. If any comes back, the
// failure names the exact file.
const DELETED_FILES = [
  // dec-2 — the seeder and its frozen content.
  "packages/server/src/services/starter-spec.ts",
  "packages/server/src/db/starter-spec.fixture.ts",
  // t-3 — the one-shot demo→starter backfill, whose job finished on 2026-07-13 and whose
  // seeding half is now wrong. Its deletion sweep replacement is starter-spec-purge.ts.
  "packages/server/src/services/demo-to-starter-sweep.ts",
  "packages/server/src/services/demo-to-starter-sweep.integration.test.ts",
  "packages/server/scripts/sweep-demo-to-starter.ts",
];

// Module tokens no surviving `import … from '…'` may reference. Matched against the import
// SPECIFIER only (never comments or prose), so this file's own header — and the purge
// service's — can discuss the retired seeder without tripping the scan.
const FORBIDDEN_IMPORT_TOKENS = [
  "starter-spec.fixture",
  "services/starter-spec",
  "./starter-spec.js",
  "demo-to-starter-sweep",
  "sweep-demo-to-starter",
];

// Identifiers that must not appear ANYWHERE in source (not just in imports): the deleted
// seeder's symbols and the retired env-var gate. Unlike the import scan this is a raw
// text match, so each needs an allowlist of files permitted to MENTION it in prose.
const FORBIDDEN_IDENTIFIERS = [
  "seedStarterSpec",
  "STARTER_SPEC_TITLE",
  "STARTER_SPEC_SECTIONS",
  "MEMEX_HANDHOLD_SIGNUP_SEED",
  // dec-3 — the variant-behaviour hook. Re-adding an empty registry or a no-op control
  // behaviour puts a switchboard wired to nothing back on the signup path.
  "BEHAVIOUR_REGISTRY",
  "runVariantBehaviour",
  "CONTROL_BEHAVIOUR",
];

// Files allowed to MENTION a forbidden identifier, each for a stated reason. Keep this
// list short: every entry is a place the removal is described rather than performed.
const IDENTIFIER_MENTION_ALLOWLIST = [
  // This scan itself — it has to name what it forbids.
  "packages/server/src/__regression__/starter-spec-removed.static-scan.spec-509.regression.test.ts",
  // The provisioning guard explains WHY it is unconditional by naming the retired gate.
  "packages/server/src/services/user-namespaces.provisioning-dec6.test.ts",
  // The vitest configs record why the gate no longer appears in their env blocks.
  "packages/server/vitest.config.ts",
  "packages/server/vitest.rls.config.ts",
  // experiments.ts + its suite explain the dec-3 removal by naming the deleted symbols.
  "packages/server/src/services/experiments.ts",
  "packages/server/src/services/experiments.test.ts",
].map((p) => p.split("/").join("/"));

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "coverage") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const IMPORT_FROM = /(?:from|import)\s+['"]([^'"]+)['"]/g;

const relFromRepo = (abs: string): string => abs.slice(REPO_ROOT.length + 1);

describe("spec-509 — the provisioned starter Spec is fully removed (ac-14 / ac-16 / ac-20)", () => {
  it("every deleted starter-spec file is gone (ac-14)", () => {
    tagAc(AC(14));
    const survivors = DELETED_FILES.filter((rel) => existsSync(join(REPO_ROOT, rel)));
    expect(survivors).toEqual([]);
  });

  it("no source file across server + UI imports a deleted starter-spec module (ac-14)", () => {
    tagAc(AC(14));
    const files = [...walk(SERVER_SRC), ...walk(UI_SRC)];
    // Sanity: the walker actually found the trees (guards a silent empty-scan pass).
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      IMPORT_FROM.lastIndex = 0;
      while ((m = IMPORT_FROM.exec(src)) !== null) {
        const spec = m[1];
        if (FORBIDDEN_IMPORT_TOKENS.some((tok) => spec.includes(tok))) {
          offenders.push(`${relFromRepo(file)} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the seeder's symbols and its env-var gate appear nowhere but the removal's own docs (ac-14 / ac-16)", () => {
    tagAc(AC(14));
    tagAc(AC(16));
    const files = [
      ...walk(SERVER_SRC),
      ...walk(UI_SRC),
      join(REPO_ROOT, "packages/server/vitest.config.ts"),
      join(REPO_ROOT, "packages/server/vitest.rls.config.ts"),
    ].filter((f) => existsSync(f));

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relFromRepo(file);
      if (IDENTIFIER_MENTION_ALLOWLIST.includes(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const id of FORBIDDEN_IDENTIFIERS) {
        if (src.includes(id)) offenders.push(`${rel} → ${id}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the env-gated test surface exposes no starter-seeding endpoint (ac-20)", () => {
    tagAc(AC(20));
    const testSurface = join(SERVER_SRC, "routes/__test__.ts");
    expect(existsSync(testSurface)).toBe(true);
    const src = readFileSync(testSurface, "utf8");
    // The route itself, and the arm-pin payload shape that drove it.
    expect(src).not.toMatch(/["'`]\/seed-experiment-arm["'`]/);
    expect(src).not.toMatch(/seedExperimentArmSchema/);
    expect(src).not.toMatch(/z\.literal\(\s*["']starter_spec["']\s*\)/);
  });

  it("no e2e journey seeds or asserts a starter Spec (ac-20)", () => {
    tagAc(AC(20));
    const e2eDir = join(REPO_ROOT, "packages/ui/e2e");
    const files = walk(e2eDir);
    // Sanity: the journey suite was actually found.
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (src.includes("seed-experiment-arm") || src.includes("starterSpecHandle")) {
        offenders.push(relFromRepo(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  // dec-2's replacement for the deleted backfill: the purge sweep must EXIST, since ac-3
  // (every pristine copy gone from prod) has no other delivery mechanism.
  it("the deletion sweep that replaces the backfill exists (ac-14)", () => {
    tagAc(AC(14));
    const service = join(SERVER_SRC, "services/starter-spec-purge.ts");
    const script = join(REPO_ROOT, "packages/server/scripts/purge-starter-specs.ts");
    expect(existsSync(service)).toBe(true);
    expect(existsSync(script)).toBe(true);

    const src = readFileSync(service, "utf8");
    expect(src).toMatch(/export async function purgeStarterSpecs\b/);
    expect(src).toMatch(/export async function purgeStarterSpecsForMemex\b/);
    // dec-1: mcp_tool_calls is deliberately never consulted — an unindexable substring
    // scan for a signal already covered by doc_views (std-39 cl-24).
    expect(src).not.toMatch(/mcpToolCalls/);
  });
});
