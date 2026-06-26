// spec-290 dec-4 (ac-11) — the app-wide DEFAULT text colour is PRIMARY, not
// secondary. The v4 migration left body defaulting to --ch-text-secondary, so any
// element written without an explicit text-* utility rendered de-emphasised
// (invisible at large sizes — the Stats-tab "white-on-white", spec-406). This
// static-scan guard locks the default to primary in BOTH theme roots so a
// regression to a secondary (or absent) default fails CI.
//
// Static scan rather than a computed-style assertion: jsdom does not apply the
// real index.css cascade, so getComputedStyle would not see the base rule.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-11';

const HERE = dirname(fileURLToPath(import.meta.url));
const indexCss = readFileSync(join(HERE, './index.css'), 'utf8');

// Pull the declaration block for a base theme-root rule, e.g. `.light body, .light`.
function blockFor(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = indexCss.match(re);
  if (!m) throw new Error(`could not find the \`${selector}\` rule in index.css`);
  return m[1];
}

// The `color:` declaration inside a block (last one wins, mirroring the cascade).
function colourDecl(block: string): string {
  const matches = [...block.matchAll(/(?:^|[;{])\s*color\s*:\s*([^;]+);/g)];
  if (matches.length === 0) throw new Error('no `color:` declaration in the block');
  return matches[matches.length - 1][1].trim();
}

describe('spec-290 dec-4: the default text colour is primary, not secondary', () => {
  for (const selector of ['.dark body, .dark', '.light body, .light']) {
    it(`\`${selector}\` defaults text colour to --ch-text-primary`, () => {
      tagAc(AC);
      const colour = colourDecl(blockFor(selector));
      expect(colour).toContain('--ch-text-primary');
      // The trap we are guarding against: a secondary (or muted) default.
      expect(colour).not.toContain('--ch-text-secondary');
      expect(colour).not.toContain('--ch-text-muted');
    });
  }
});
