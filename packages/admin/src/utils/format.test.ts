// Unit tests for the format helpers. UNTAGGED on purpose — these are pure-
// function checks (no AC emission). The omnibox's plain-text-snippet AC (ac-20)
// is proved end-to-end in SearchPalette.test.tsx; this file pins the underlying
// markdown-stripping + truncation contract of snippetText directly.

import { describe, it, expect } from 'vitest';
import { snippetText } from './format';

describe('snippetText', () => {
  it('strips inline emphasis to its visible text', () => {
    expect(snippetText('This is **bold** and _italic_ and ~~struck~~')).toBe(
      'This is bold and italic and struck',
    );
  });

  it('reduces links and images to their visible label', () => {
    expect(snippetText('see [the docs](https://example.com/x) here')).toBe(
      'see the docs here',
    );
    expect(snippetText('logo ![alt text](logo.png) end')).toBe('logo alt text end');
  });

  it('drops heading hashes, blockquotes, and list markers', () => {
    expect(snippetText('## Title\n\n- one\n- two\n> quoted')).toBe(
      'Title one two quoted',
    );
    expect(snippetText('1. first\n2. second')).toBe('first second');
  });

  it('keeps the text inside code fences but drops the backticks', () => {
    expect(snippetText('use `npm install` then `pnpm build`')).toBe(
      'use npm install then pnpm build',
    );
    expect(snippetText('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips raw HTML tags', () => {
    expect(snippetText('hello <img src=x onerror=alert(1)> world')).toBe(
      'hello world',
    );
  });

  it('collapses whitespace and truncates with an ellipsis', () => {
    const long = 'word '.repeat(60).trim(); // 60 words, well over 120 chars
    const out = snippetText(long, 120);
    expect(out.length).toBeLessThanOrEqual(121); // 120 + the ellipsis char
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short plain text untouched (no ellipsis)', () => {
    expect(snippetText('just a short line')).toBe('just a short line');
  });

  it('handles empty / whitespace input safely', () => {
    expect(snippetText('')).toBe('');
    expect(snippetText('   \n\t  ')).toBe('');
  });
});
