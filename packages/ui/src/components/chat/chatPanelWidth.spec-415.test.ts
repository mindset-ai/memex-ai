// spec-415 (dec-2, ac-6): the width bounds have ONE source of truth. The shared
// module exports the three constants, and both consumers (ResizableChatRail.tsx and
// DocumentShell.tsx) import the floor from it — with ResizableChatRail no longer
// defining its own min/default/max literals, so the floor can't diverge again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';
import { CHAT_MIN_W, CHAT_DEFAULT_W, CHAT_MAX_W } from './chatPanelWidth';

const AC6 = 'mindset-prod/memex-building-itself/specs/spec-415/acs/ac-6';

const here = dirname(fileURLToPath(import.meta.url));
const rail = readFileSync(join(here, 'ResizableChatRail.tsx'), 'utf8');
const shell = readFileSync(join(here, '..', 'DocumentShell.tsx'), 'utf8');

describe('chatPanelWidth — single source of truth for the agent panel floor (spec-415)', () => {
  it('ac-6: the shared module exports the three width constants with the canonical values', () => {
    tagAc(AC6);
    expect(CHAT_MIN_W).toBe(300);
    expect(CHAT_DEFAULT_W).toBe(384);
    expect(CHAT_MAX_W).toBe(720);
  });

  it('ac-6: both ResizableChatRail and DocumentShell import the floor from the shared module', () => {
    tagAc(AC6);
    // ResizableChatRail pulls all three from the shared module.
    expect(rail).toMatch(
      /import\s*\{[^}]*\bCHAT_MIN_W\b[^}]*\}\s*from\s*['"]\.\/chatPanelWidth['"]/,
    );
    // DocumentShell pulls the floor from the shared module.
    expect(shell).toMatch(
      /import\s*\{[^}]*\bCHAT_MIN_W\b[^}]*\}\s*from\s*['"]\.\/chat\/chatPanelWidth['"]/,
    );
  });

  it('ac-6: ResizableChatRail no longer defines its own min/default/max literals', () => {
    tagAc(AC6);
    // No local `const CHAT_*_W = <number>` declarations remain in the rail — the
    // numeric literals live only in the shared module now.
    expect(rail).not.toMatch(/const\s+CHAT_MIN_W\s*=/);
    expect(rail).not.toMatch(/const\s+CHAT_DEFAULT_W\s*=/);
    expect(rail).not.toMatch(/const\s+CHAT_MAX_W\s*=/);
  });

  it('ac-6: DocumentShell wires the shared floor into the drift Panel minSize as a px value', () => {
    tagAc(AC6);
    expect(shell).toMatch(/minSize=\{`\$\{CHAT_MIN_W\}px`\}/);
  });
});
