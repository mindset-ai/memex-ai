// spec-222 t-15 (dec-1) — the canonical website embed shape. (ac-1)
//
// ac-1: "The static website embeds the voice guide with a single <script> include
// plus one init call, with no build step on the site — a visitor can click Specky,
// grant the mic, and hold a voice conversation."
//
// The EMBED SHAPE (single script + one init, no build step) is pinned here against
// the canonical example the site author copies. The LIVE half ("click Specky, grant
// the mic, hold a voice conversation") needs a real browser + mic + running backend
// — it is manual on-device sign-off (the spec-190 t-9 method), recorded in the t-15
// task. The doorway-renders-on-init half is already proven in jsdom (ac-7).

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC_1 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-1';

const here = dirname(fileURLToPath(import.meta.url)); // packages/guide-sdk/src/__embed__
const sdkRoot = resolve(here, '..', '..'); // packages/guide-sdk
const embed = readFileSync(resolve(sdkRoot, 'examples', 'website-embed.html'), 'utf8');

/** Count non-overlapping matches. */
const count = (re: RegExp) => (embed.match(re) ?? []).length;

describe('spec-222 t-15: canonical website embed (ac-1)', () => {
  it('embeds via ONE vendored bundle <script> include', () => {
    tagAc(AC_1);
    // Exactly one include of the vendored, same-origin bundle.
    expect(count(/<script[^>]*src="\/js\/memex-guide\.js"/g)).toBe(1);
    // It is an ES module (the engine is code-split + lazy — t-5).
    expect(embed).toMatch(/<script[^>]*type="module"[^>]*src="\/js\/memex-guide\.js"/);
  });

  it('mounts via ONE init() call naming only a surface + backend + injected navigation', () => {
    tagAc(AC_1);
    expect(count(/window\.mindset\.guide\.init\(/g)).toBe(1);
    expect(embed).toMatch(/surface:\s*'memex-website'/); // the surface selects corpus + persona server-side
    expect(embed).toMatch(/backend:\s*'https:\/\/memex\.ai\/guide\/v1'/); // versioned public endpoint
    expect(embed).toMatch(/window\.mindset\.guide\.staticSiteNavigation\(/); // injected static-site adapter
    // The client never supplies persona/prompt text (ac-20) — only a surface id.
    // (Checked as CONFIG KEYS, so an explanatory comment mentioning the word is fine.)
    expect(embed).not.toMatch(/\b(persona|systemPrompt|prompt)\s*:/i);
    expect(embed).not.toMatch(/['"]system['"]\s*:/);
  });

  it('requires NO build step — it is plain HTML (no bundler/import-map/framework)', () => {
    tagAc(AC_1);
    expect(embed).toMatch(/^<!doctype html>/i);
    // No site-build artifacts: no import map, no framework mount, no bundler hints.
    expect(embed).not.toMatch(/type="importmap"/);
    expect(embed).not.toMatch(/webpack|vite|rollup|esbuild/i);
    expect(embed).not.toMatch(/from ['"]react['"]/);
  });
});
