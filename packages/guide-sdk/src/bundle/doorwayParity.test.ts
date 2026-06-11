// Doorway parity (spec-222 live-embed fixes): the live website must show ONE idle
// treatment across the loader→engine hand-off — the ENGINE's native round idle
// VoiceIcon (64px `h-16 w-16 rounded-full bg-surface ring-1 ring-border shadow-lg`
// circle containing a 40px Specky mark), which transitions cleanly into the
// horizontal session pill when a session goes active. The thin loader paints
// first (no React, no Tailwind, no token vars), so its DOORWAY_CSS hardcodes the
// values those classes RESOLVE to inside the shadow root, where ENGINE_CSS
// unconditionally declares the app's DARK-theme tokens on :host.
//
// These tests guard both halves of that contract:
//   1. the engine side stays NATIVE — idle branch renders the 40px animated
//      Specky inside an un-overridden VoiceIcon (no `[data-voice-affordance]`
//      restyle in ENGINE_CSS);
//   2. the loader's doorway mirrors that treatment — same 64px circle geometry,
//      same resolved surface/ring colours (derived live from ENGINE_CSS's token
//      triplets, so a token change flags the hardcoded loader hex), same
//      composed ring+shadow elevation, same 40px mark width.
//
// They read loader.ts / engine.tsx as TEXT (importing loader.ts would
// self-register the window global; importing engine.tsx would drag in the whole
// orchestrator) and import ENGINE_CSS directly (it is a plain string module).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CSS } from './engineStyles';

const here = dirname(fileURLToPath(import.meta.url));
const loaderSrc = readFileSync(join(here, 'loader.ts'), 'utf8');
const engineSrc = readFileSync(join(here, 'engine.tsx'), 'utf8');
const voiceIconSrc = readFileSync(join(here, '..', 'session', 'VoiceIcon.tsx'), 'utf8');

/** Extract the loader's DOORWAY_CSS template literal. */
const doorwayCss = loaderSrc.match(/const DOORWAY_CSS = `([\s\S]*?)`;/)?.[1] ?? '';

/** Resolve an ENGINE_CSS `--color-*` token (space-separated RGB triplet) to hex. */
function tokenToHex(token: string): string {
  const triplet = ENGINE_CSS.match(new RegExp(`${token}: (\\d+) (\\d+) (\\d+);`));
  expect(triplet, `ENGINE_CSS should declare the ${token} token`).toBeTruthy();
  const [, r, g, b] = triplet!;
  return (
    '#' +
    [r, g, b].map((c) => Number(c).toString(16).padStart(2, '0')).join('')
  );
}

describe('doorway parity: the engine keeps its NATIVE round idle VoiceIcon', () => {
  it('the idle branch renders the 40px Specky mark inside a stock VoiceIcon', () => {
    // The app-native idle treatment: 40px Specky, default (animated) frame.
    expect(engineSrc).toContain('<VoiceIcon mark={<Specky size={40} />} />');
  });

  it('ENGINE_CSS does NOT override the VoiceIcon affordance', () => {
    // The previous direction restyled the engine's idle button into the loader's
    // white doorway pill; that override must stay gone so VoiceIcon's own
    // classes (h-16 w-16 rounded-full bg-surface ...) paint the circle.
    expect(ENGINE_CSS).not.toContain('data-voice-affordance');
  });
});

describe('doorway parity: the loader doorway mirrors the engine idle treatment', () => {
  it('VoiceIcon still carries the classes the loader translated', () => {
    // If VoiceIcon's idle look changes, the loader's hardcoded translation (and
    // this suite) must be revisited.
    expect(voiceIconSrc).toContain(
      'flex h-16 w-16 items-center justify-center rounded-full bg-surface shadow-lg ring-1 ring-border transition hover:scale-105',
    );
  });

  it('matches the 64px circle geometry (h-16 w-16 rounded-full, flex-centred)', () => {
    // h-16/w-16 resolve to 4rem = 64px (ENGINE_CSS pins the same equivalence).
    expect(ENGINE_CSS).toContain('.h-16 { height: 4rem; }');
    expect(ENGINE_CSS).toContain('.w-16 { width: 4rem; }');
    expect(doorwayCss).toContain('height: 64px');
    expect(doorwayCss).toContain('width: 64px');
    expect(doorwayCss).toContain('border-radius: 9999px'); // rounded-full
    expect(doorwayCss).toContain('display: inline-flex');
    expect(doorwayCss).toContain('align-items: center');
    expect(doorwayCss).toContain('justify-content: center');
    // The circle owns the geometry — no doorway-style hugging padding.
    expect(doorwayCss).toContain('padding: 0');
  });

  it('hardcodes the colours ENGINE_CSS resolves inside the shadow root (dark tokens)', () => {
    // ENGINE_CSS declares the DARK theme tokens unconditionally on :host (the
    // engine is not theme-aware inside the shadow root), so the loader pins the
    // dark values. Derive them from the live token triplets so token drift in
    // engineStyles.ts fails here instead of shipping a mismatched doorway.
    const surfaceHex = tokenToHex('--color-surface'); // bg-surface
    const edgeHex = tokenToHex('--color-edge'); // ring-border hairline
    expect(surfaceHex).toBe('#1b1e24');
    expect(edgeHex).toBe('#3e4451');
    expect(doorwayCss).toContain(`background: ${surfaceHex}`);
    expect(doorwayCss).toContain(`0 0 0 1px ${edgeHex}`);
  });

  it('composes the ring + shadow-lg elevation exactly like ENGINE_CSS', () => {
    // ENGINE_CSS's `.ring-1.shadow-lg` rule layers the hairline ring with the
    // shadow-lg drop shadows; the doorway carries the same three layers.
    for (const layer of [
      '0 10px 15px -3px rgba(0, 0, 0, 0.35)',
      '0 4px 6px -4px rgba(0, 0, 0, 0.35)',
    ]) {
      expect(ENGINE_CSS).toContain(layer);
      expect(doorwayCss).toContain(layer);
    }
  });

  it('renders the Specky mark at the engine idle mark size (40px wide)', () => {
    // The engine's idle mark width...
    const engineMark = engineSrc.match(/<VoiceIcon mark=\{<Specky size=\{(\d+)\} \/>\} \/>/)?.[1];
    expect(engineMark).toBe('40');
    // ...is the loader's mark constant (img width; height derives from the
    // SVG's intrinsic aspect ratio, identical to the Specky component's math).
    const markPx = loaderSrc.match(/const MARK_PX = (\d+)/)?.[1];
    expect(markPx).toBe(engineMark);
    expect(loaderSrc).toContain('img.width = MARK_PX');
    expect(loaderSrc).toContain('img.height = Math.round(MARK_PX * SPECKY_ASPECT)');
  });

  it('engine resets are zero-specificity — utilities must win the cascade', () => {
    // Live bug (spec-222): a bare [data-memex-guide='engine'] button reset is
    // (0,1,1) and its `background: none` beats every single-class utility like
    // .bg-surface (0,1,0) — the idle icon and pill painted transparent on the
    // website (doorway dark on load, see-through after a session). Every reset
    // selector that targets engine descendants must be wrapped in :where() so
    // utility classes always out-rank it.
    const noComments = ENGINE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const resetSelectors = noComments.match(/^[^@{}]*\[data-memex-guide='engine'\][^{}]*(?={)/gm) ?? [];
    expect(resetSelectors.length).toBeGreaterThan(0);
    for (const sel of resetSelectors) {
      for (const part of sel.split(',')) {
        expect(part.trim(), `engine reset selector must be :where()-wrapped: ${part.trim()}`).toMatch(
          /^:where\(/,
        );
      }
    }
  });

  it('mirrors the engine transition + anchor position', () => {
    // ENGINE_CSS `.transition`: 150ms cubic-bezier(0.4, 0, 0.2, 1); the loader
    // applies the same curve (transform-only — that is all the doorway animates).
    expect(ENGINE_CSS).toContain('transition-duration: 150ms');
    expect(doorwayCss).toContain('transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1)');
    expect(doorwayCss).toContain('transform: scale(1.05)'); // hover:scale-105
    // Engine ANCHOR_STYLE: fixed, bottom/right 24, z 2147483000.
    expect(doorwayCss).toContain('bottom: 24px');
    expect(doorwayCss).toContain('right: 24px');
    expect(doorwayCss).toContain('z-index: 2147483000');
  });
});
