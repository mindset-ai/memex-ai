// t-4 runtime binding (dec-3 / ac-16): the highlight tool resolves a registry id
// to the live DOM node via data-guide-id (findGuideElement), the router path maps
// to a screenKey (currentScreenKey), and every data-guide-id wired into the UI is
// a real registry id (consistency scan — no dangling DOM ids).

import { describe, it, expect, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { allGuideElementIds } from '@memex/shared';
import { findGuideElement, currentScreenKey } from './guideElements';

const AC16 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-16';

describe('findGuideElement (ac-16 — id → live DOM node)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves a registry id to the node carrying its data-guide-id', () => {
    document.body.innerHTML =
      '<div><button data-guide-id="new-spec-button">+ New Spec</button></div>';
    const node = findGuideElement('new-spec-button');
    expect(node).not.toBeNull();
    expect(node?.tagName).toBe('BUTTON');
  });

  it('returns null when the element is not currently rendered', () => {
    document.body.innerHTML = '<div>no targets here</div>';
    expect(findGuideElement('phase-pill')).toBeNull();
  });
});

describe('currentScreenKey (ac-16 — router path → screenKey)', () => {
  it('derives the screen key from a pathname via the registry mapping', () => {
    expect(currentScreenKey('/acme/team/specs/spec-12')).toBe('spec-detail');
    expect(currentScreenKey('/acme/team/standards')).toBe('standards-list');
    expect(currentScreenKey('/login')).toBeNull();
  });
});

describe('data-guide-id consistency (ac-16 — components match registry ids)', () => {
  it('every data-guide-id wired into the UI is a registered element id', () => {
    const uiSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const known = new Set(allGuideElementIds());
    const found: Array<{ id: string; file: string }> = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry) || /\.test\./.test(entry)) continue;
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/data-guide-id="([a-z0-9-]+)"/g)) {
          found.push({ id: m[1], file: full });
        }
      }
    };
    walk(uiSrc);

    // There is at least one wired target (the New Spec button), and none dangle.
    expect(found.length).toBeGreaterThan(0);
    const dangling = found.filter((f) => !known.has(f.id));
    expect(dangling, `dangling data-guide-id(s): ${JSON.stringify(dangling)}`).toEqual([]);
    tagAc(AC16);
  });
});
