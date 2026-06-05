import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-182 dec-7 / ac-16 — Fair-code core: nothing this spec ships carries an
// `.ee.` filename or `.ee/` dirname marker.

const AC_CORE = 'mindset-prod/memex-building-itself/specs/spec-182/acs/ac-16';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const TOUCHED = [
  'pages/DocDocument.tsx',
  'components/TransitionSentence.tsx',
  'components/IssuePanel.tsx',
];

describe('licensing tier (spec-182 dec-7)', () => {
  it('every touched file exists at its core (non-.ee) path', () => {
    tagAc(AC_CORE);
    for (const rel of TOUCHED) {
      expect(existsSync(join(SRC_DIR, rel)), `${rel} should exist`).toBe(true);
      expect(rel.includes('.ee.'), `${rel} must not carry the .ee. marker`).toBe(false);
      expect(rel.includes('.ee/'), `${rel} must not sit under .ee/`).toBe(false);
    }
  });
});
