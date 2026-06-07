// Specky component — spec-197 Slice 2 standalone renderer (t-5).
// These assertions need NOTHING from spec-190: they exercise the rendering
// piece on its own. The wiring-dependent ACs (ac-2/ac-9 click→session,
// ac-8 in-view quiet glyph, ac-1 both-surfaces) are verified by t-2/t-3 once
// spec-190's VoiceIcon/VoiceLayer are on develop.

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Specky } from './Specky';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_TRANSPARENT_SCALABLE = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-3';
const AC_IDLE_ONLY = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-7';
const AC_IMG_NO_RUNTIME = 'mindset-prod/memex-building-itself/specs/spec-197/acs/ac-10';

describe('Specky component (spec-197 t-5 — standalone renderer)', () => {
  it('renders a plain <img> from the bundler /assets/ URL — no canvas/Lottie/inline-SVG runtime (ac-10)', () => {
    tagAc(AC_IMG_NO_RUNTIME);
    const { container } = render(<Specky alt="Specky" />);
    const img = screen.getByRole('img', { name: 'Specky' });
    expect(img.tagName).toBe('IMG');
    // src is a BUNDLER-resolved URL — either an inlined data: URI (Vite inlines
    // assets under its ~4KB limit; specky.svg is ~3.7KB) OR an /assets/ file URL
    // when larger. Crucially it is NEVER a hardcoded web-root path like
    // /specky.svg (which the LB url-map does not route — see dec-3).
    const src = img.getAttribute('src')!;
    expect(src).toBeTruthy();
    expect(src.startsWith('data:image/svg+xml') || src.includes('/assets/')).toBe(true);
    expect(src).not.toBe('/specky.svg');
    // When inlined, the rendered <img> carries the real Specky artwork together
    // with its self-contained idle animation and reduced-motion fallback.
    if (src.startsWith('data:')) {
      const markup = decodeURIComponent(src);
      expect(markup).toContain('clip-root');
      expect(markup).toContain('prefers-reduced-motion');
    }
    // No animation runtime: it's an <img>, not an inline <svg> or a canvas (no Lottie).
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('scales without distortion: height derives from the SVG aspect ratio (ac-3)', () => {
    tagAc(AC_TRANSPARENT_SCALABLE);
    render(<Specky alt="Specky" size={120} />);
    const img = screen.getByRole('img', { name: 'Specky' });
    expect(img.getAttribute('width')).toBe('120');
    // round(120 * 330/240) = 165 — same 240:330 proportion as the source SVG.
    expect(img.getAttribute('height')).toBe('165');
  });

  it('is idle-only: exposes no session-state variants, one self-contained idle asset (dec-1=a / ac-7)', () => {
    tagAc(AC_IDLE_ONLY);
    // Compile-time guarantee the API surfaces no listening/thinking/speaking/
    // ducked/state prop — adding one would fail this exhaustive Record.
    type Keys = keyof import('./Specky').SpeckyProps;
    const allowed: Record<Keys, true> = { size: true, alt: true, className: true };
    expect(Object.keys(allowed).sort()).toStrictEqual(['alt', 'className', 'size']);
    // The same single idle SVG is the source regardless of usage — no variant swap.
    const first = render(<Specky alt="a" />).container.querySelector('img')!.getAttribute('src');
    const second = render(<Specky alt="b" size={200} />).container.querySelector('img')!.getAttribute('src');
    expect(first).toBe(second);
    expect(first!.startsWith('data:image/svg+xml') || first!.includes('/assets/')).toBe(true);
  });

  it('is decorative by default (alt="") so it does not double-announce inside a labelled control', () => {
    const { container } = render(<Specky />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('alt')).toBe('');
  });
});
