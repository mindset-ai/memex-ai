// spec-508 dec-1 / dec-2 (ac-2 / ac-6 / ac-10) — the voice guide is GONE, entirely.
//
// Barrie's directive: the spec-190-lineage voice-to-voice loop (mic capture, VAD,
// ElevenLabs STT/TTS, the voice WebSocket proxy, VoiceLayer/session UI, the spoken
// first-run greeting, barge-in/playback) is hard-deleted — including the whole
// @memex/guide-sdk package, which a dependency walk showed was the voice engine
// with no non-voice consumer.
//
// The green typecheck already proves no source file imports a deleted SYMBOL. This
// static scan is the regression guard: it fails loudly if a deleted module ever
// comes back or gets re-imported, and it sweeps config/env surfaces the typechecker
// can't see (deploy.sh, .env.example, package manifests) for ELEVENLABS residue.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-508/acs/ac-${n}`;

const SERVER_SRC = join(__dirname, "..");
const UI_SRC = join(__dirname, "../../../ui/src");
const REPO_ROOT = join(__dirname, "../../../..");

// Every voice-guide surface the removal deleted, keyed by repo-relative path.
const DELETED_PATHS = [
  "packages/guide-sdk",
  "packages/ui/src/voice",
  "packages/ui/src/components/specky-dialogue",
  "packages/ui/src/components/onboarding/FirstRunGreeting.tsx",
  "packages/ui/src/components/onboarding/MicGlyph.tsx",
  "packages/ui/src/components/onboarding/micPermission.ts",
  "packages/ui/src/components/onboarding/ValueIntroPanel.tsx",
  "packages/ui/scripts/copy-vad-assets.mjs",
  "packages/ui/public/assets/vad",
  "packages/ui/public/vad",
  "packages/server/src/routes/voice.ts",
  "packages/server/src/routes/guide-public.ts",
  "packages/server/src/routes/onboarding.ts",
  "packages/server/src/agent/voice",
  "packages/server/src/agent/elevenlabs-client.ts",
  "packages/server/src/agent/elevenlabs-fake.ts",
  "packages/server/src/services/guide-content.ts",
  "packages/server/src/services/guide-content-import.ts",
  "packages/server/scripts/import-guide-content.ts",
  "packages/server/scripts/smoke-elevenlabs.ts",
  "packages/shared/src/guide-registry.ts",
  "packages/shared/src/guide-tools.ts",
  "guide-content",
  "packages/ui/e2e/journey-21-voice-guide.spec.ts",
  "packages/ui/e2e/journey-23-first-run-greeting.spec.ts",
];

// Module tokens no surviving `import … from '…'` may reference. Matched against the
// import SPECIFIER only, so prose mentions in comments never trip the scan.
const FORBIDDEN_IMPORT_TOKENS = [
  "@memex/guide-sdk",
  "elevenlabs-client",
  "elevenlabs-fake",
  "guide-registry",
  "guide-tools",
  "guide-content",
  "micPermission",
  "MicGlyph",
  "FirstRunGreeting",
  "SpeckyDialogue",
  "@ricky0123/vad-web",
  "/voice/session/VoiceLayer",
  "routes/voice",
  "routes/guide-public",
  "routes/onboarding.js",
];

// Config/env surfaces the typechecker can't see, swept for secret/env residue.
const CONFIG_SURFACES = [
  "packages/server/.env.example",
  "packages/server/deploy.sh",
  "packages/server/package.json",
  "packages/ui/package.json",
  "packages/ui/vite.config.ts",
  "packages/ui/vitest.config.ts",
  "packages/ui/playwright.config.ts",
  "scripts/deploy.env.example",
  "Makefile",
  "docker-compose.yml",
];

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

describe("spec-508 — the voice guide is fully removed (ac-2 / ac-6 / ac-10)", () => {
  it("every deleted voice-guide path is gone from the REPOSITORY (ac-2)", () => {
    tagAc(AC(2));

    // spec-512 issue-4: this asserted filesystem existence, which made it green in
    // CI (clean checkout) and permanently RED on any developer machine carrying
    // pre-spec-508 build residue — untracked `packages/guide-sdk/{dist,node_modules}`
    // and the downloaded `packages/ui/public/assets/vad/*.wasm|.onnx`. Neither is in
    // the index; `a1bb0e6` removed them from git and left the artefacts on disk.
    //
    // "The voice guide is removed" is a claim about the REPOSITORY, and the
    // repository is git's index — not one laptop's disk. A guard that cries wolf
    // locally trains everyone to ignore the regression suite, which is the same
    // erosion of trust in a green signal that spec-512 exists to reverse.
    const tracked = execFileSync("git", ["ls-files", "--", ...DELETED_PATHS], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((l) => l.trim() !== "");

    expect(
      tracked,
      `Deleted voice-guide path(s) are tracked by git again (spec-508 ac-2):\n` +
        `  ${tracked.join("\n  ")}\n\n` +
        `The voice stack was removed in a1bb0e6 and must stay removed.\n\n` +
        `Fix — untrack the offending path(s):\n` +
        `  git rm -r --cached ${tracked[0] ?? "<path>"}\n\n` +
        `Check: packages/server/src/__regression__/voice-guide-removed.static-scan.spec-508.regression.test.ts`,
    ).toEqual([]);

    // Denominator: prove `git ls-files` ran against a real list, so a bad path
    // argument or a non-git cwd cannot turn this into a vacuous pass.
    expect(DELETED_PATHS.length).toBeGreaterThan(3);
  });

  it("no source file across server + UI imports a deleted voice module (ac-6 / ac-7)", () => {
    // ac-7: the guide-sdk package is gone and nothing imports it — the green
    // workspace typecheck alongside this scan is the build-success half.
    tagAc(AC(6));
    tagAc(AC(7));
    const files = [...walk(SERVER_SRC), ...walk(UI_SRC)];
    // Sanity: the walker actually found the trees (guards against a silent empty-scan pass).
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      if (file.includes("voice-guide-removed.static-scan")) continue;
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

  it("no ELEVENLABS/voice residue in env, deploy, or package config (ac-3 / ac-5 / ac-6)", () => {
    // ac-3: no residue outside code (env examples, deploy script, Makefile).
    // ac-5: no voice-only dependency left in any package manifest (the two
    // manifests in CONFIG_SURFACES are the ones that carried vad-web/guide-sdk).
    tagAc(AC(3));
    tagAc(AC(5));
    tagAc(AC(6));
    const offenders: string[] = [];
    for (const rel of CONFIG_SURFACES) {
      const full = join(REPO_ROOT, rel);
      if (!existsSync(full)) continue;
      const src = readFileSync(full, "utf8");
      if (/ELEVENLABS|elevenlabs|vad-web|guide-sdk|copy-vad-assets/i.test(src)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the removal touched no EE-licensed path (ac-10)", () => {
    tagAc(AC(10));
    // The deleted paths are the licence-relevant surface of this spec; none may
    // carry the .ee marker (deleting an EE file would silently shrink the
    // commercial surface — std-25 requires that to be deliberate).
    const eeMarked = DELETED_PATHS.filter((p) => /\.ee\.|(^|\/)\.ee(\/|$)/.test(p));
    expect(eeMarked).toEqual([]);
  });
});
