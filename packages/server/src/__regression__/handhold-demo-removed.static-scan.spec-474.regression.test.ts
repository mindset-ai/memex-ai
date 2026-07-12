// spec-474 dec-3 / dec-4 (ac-5 / ac-18) — the handhold demo is GONE, and its residual
// cleanup half lives in a dedicated module.
//
// The A/B experiment concluded (Variant B, the starter spec, won), so all handhold-demo
// code was deleted: the server seeder/fixture/reset route and the entire UI walkthrough
// surface (DemoWalkthroughController, the reveal pointer/context, demo spec fixtures). What
// remains is the demo-DOC teardown used by the one-shot sweep — extracted into
// services/demo-cleanup.ts (clearDemoDocs / clearDemoDocsForMemex / listDemoDocIds).
//
// The green typecheck already proves no source file imports a deleted SYMBOL (a dangling
// import wouldn't compile). This static scan is the belt-and-suspenders regression guard:
// it fails loudly if any of the deleted MODULES is ever re-created or re-imported, so the
// removal can't silently regress. It walks BOTH packages (server + UI) because the deleted
// surface spanned both.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-474/acs/ac-${n}`;

const SERVER_SRC = join(__dirname, "..");
const UI_SRC = join(__dirname, "../../../ui/src");

// Every handhold-demo file the removal deleted, keyed by repo-relative path. If any comes
// back, this list makes the failure name the exact file.
const DELETED_FILES = [
  "packages/server/src/services/handhold-demo.ts",
  "packages/server/src/db/handhold-demo.fixture.ts",
  "packages/server/src/db/demo-phase-callouts.fixture.ts",
  "packages/server/src/routes/handhold.ts",
  "packages/server/src/scripts/backfill-handhold-demo.ts",
  "packages/ui/src/components/DemoWalkthroughController.tsx",
  "packages/ui/src/voice/walkthrough/demoWalkthrough.ts",
  "packages/ui/src/voice/walkthrough/demoSpecs.ts",
  "packages/ui/src/hooks/useHandholdReveal.ts",
  "packages/ui/src/context/HandholdRevealContext.tsx",
];

// The module tokens no surviving `import … from '…'` may reference. Matched against the
// import SPECIFIER only (not comments/strings), so demo-cleanup.ts's header prose — which
// legitimately says "the retired handhold demo" — never trips the scan.
const FORBIDDEN_IMPORT_TOKENS = [
  "handhold-demo",
  "/handhold", // routes/handhold
  "demo-phase-callouts",
  "backfill-handhold",
  "DemoWalkthroughController",
  "demoWalkthrough",
  "demoSpecs",
  "useHandholdReveal",
  "HandholdRevealContext",
];

const REPO_ROOT = join(__dirname, "../../../..");

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

describe("spec-474 — the handhold demo is fully removed (ac-5 / ac-18)", () => {
  it("services/demo-cleanup.ts owns the residual demo-doc teardown (ac-18)", () => {
    tagAc(AC(18));
    const modulePath = join(SERVER_SRC, "services/demo-cleanup.ts");
    expect(existsSync(modulePath)).toBe(true);
    const src = readFileSync(modulePath, "utf8");
    // All three functions ac-18 names live here (some module-private, one exported).
    expect(src).toMatch(/function clearDemoDocs\b/);
    expect(src).toMatch(/function clearDemoDocsForMemex\b/);
    expect(src).toMatch(/function listDemoDocIds\b/);
    // Teardown-only: the module DECLARES no seeder/reveal/reset function (a prose mention of
    // the deleted seedHandholdDemo in the header comment is fine — this checks declarations).
    expect(src).not.toMatch(/function\s+(seedHandholdDemo|startWalkthrough|resetHandholdDemo)\b/);
  });

  it("every deleted handhold-demo file is gone (ac-5)", () => {
    tagAc(AC(5));
    const survivors = DELETED_FILES.filter((rel) => existsSync(join(REPO_ROOT, rel)));
    expect(survivors).toEqual([]);
  });

  it("no source file across server + UI imports a deleted handhold-demo module (ac-5 / ac-18)", () => {
    tagAc(AC(5));
    tagAc(AC(18));
    const files = [...walk(SERVER_SRC), ...walk(UI_SRC)];
    // Sanity: the walker actually found the trees (guards against a silent empty-scan pass).
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      IMPORT_FROM.lastIndex = 0;
      while ((m = IMPORT_FROM.exec(src)) !== null) {
        const spec = m[1];
        if (FORBIDDEN_IMPORT_TOKENS.some((tok) => spec.includes(tok))) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
