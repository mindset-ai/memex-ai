import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-473 ac-11 — the /home import-hero pivot introduces no Enterprise-Edition
// marker: none of the files it touches carries a `.ee.` filename segment or lives
// under a `.ee/` directory, so the surface stays fair-code / open-core [per std-25].

const AC_CORE = 'mindset-prod/memex-building-itself/specs/spec-473/acs/ac-11';

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // packages/ui/src

// Paths relative to packages/ui/src. The last three reach out to the sibling e2e
// dir and the @memex/shared package — join() resolves the `..` segments.
const TOUCHED = [
  'components/home/BuildPromptHero.tsx',
  'components/home/BuildPromptHero.spec-473.test.tsx',
  'components/NewSpecModal.tsx',
  'components/NewSpecModal.spec-473.test.tsx',
  'pages/HomeCanvas.tsx',
  'pages/DocDocument.tsx',
  '../e2e/journey-60-spec-470-new-home.spec.ts',
  '../../shared/src/usage-events-registry.ts',
  '../../shared/EVENT-STANDARD.md',
];

describe('licensing tier (spec-473 ac-11) — the import pivot stays open-core', () => {
  it('every touched file exists at its core (non-.ee) path', () => {
    tagAc(AC_CORE);
    for (const rel of TOUCHED) {
      expect(existsSync(join(SRC_DIR, rel)), `${rel} should exist`).toBe(true);
      expect(rel.includes('.ee.'), `${rel} must not carry the .ee. marker`).toBe(false);
      expect(rel.includes('.ee/'), `${rel} must not sit under .ee/`).toBe(false);
    }
  });
});
