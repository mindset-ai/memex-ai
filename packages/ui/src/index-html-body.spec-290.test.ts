// spec-290 dec-4 (ac-12) — the index.html <body> must use theme-token utilities,
// never hardcoded slate-* colours.
//
// The v4 migration left `<body class="bg-slate-900 text-slate-100">` as a dark
// pre-hydration splash. Because Tailwind v4 puts utilities in `@layer utilities`
// (which beats `@layer base` regardless of specificity), that hardcoded text colour
// overrode the theme's body rule and leaked a near-white default text colour app-wide
// — invisible on light surfaces (the scaffold "white-on-white", confirmed via a live
// browser inspection: body color stuck at slate-100 while every `--ch-*` var was the
// correct light value). The fix is `bg-page text-primary`: html starts `.dark`, so the
// splash is still dark, but the body now follows the theme after React swaps to `.light`.
//
// Static scan: the built bundle is what ships, but the <body> class is authored here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-290/acs/ac-12';

const HERE = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(HERE, '../index.html'), 'utf8');

function bodyClass(): string {
  const m = indexHtml.match(/<body[^>]*\bclass="([^"]*)"/);
  if (!m) throw new Error('could not find <body class="…"> in index.html');
  return m[1];
}

describe('spec-290 dec-4: index.html body uses theme tokens, not hardcoded slate-*', () => {
  it('the <body> class carries the theme-token utilities', () => {
    tagAc(AC);
    const cls = bodyClass();
    expect(cls).toContain('bg-page');
    expect(cls).toContain('text-primary');
  });

  it('the <body> class has NO hardcoded slate-* colour (the leak we are guarding against)', () => {
    tagAc(AC);
    const cls = bodyClass();
    // e.g. text-slate-100 / bg-slate-900 — a fixed colour that beats the theme base rule.
    expect(cls).not.toMatch(/\b(text|bg)-slate-\d/);
  });
});
