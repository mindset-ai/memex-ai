import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-164 dec-7 / ac-26 — Fair-code core: nothing this spec ships carries an
// `.ee.` filename or `.ee/` dirname marker. The touched surfaces are pinned by
// path so a later re-licensing of any of them is a deliberate, visible act
// (CLAUDE.md: "Don't move code across the line silently").

const AC_CORE = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-26';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

// Every file spec-164 created or materially changed.
const TOUCHED = [
  'utils/phaseDisplay.ts',
  'components/PhaseTabBar.tsx',
  'components/TransitionSentence.tsx',
  'components/DecisionPanel.tsx',
  'components/AcPanel.tsx',
  'components/IssuePanel.tsx',
  'components/TaskPanel.tsx',
  'components/CommentTray.tsx',
  'components/DoneSummary.tsx',
  'pages/DocDocument.tsx',
  'pages/SpecList.tsx',
  'pages/IssuesList.tsx',
];

describe('licensing tier (spec-164 dec-7)', () => {
  it('every touched file exists at its core (non-.ee) path with no .ee marker in the path', () => {
    tagAc(AC_CORE);
    for (const rel of TOUCHED) {
      expect(existsSync(join(SRC_DIR, rel)), `${rel} should exist`).toBe(true);
      expect(rel.includes('.ee.'), `${rel} must not carry the .ee. filename marker`).toBe(false);
      expect(rel.includes('.ee/'), `${rel} must not sit under a .ee/ dirname`).toBe(false);
    }
  });
});
