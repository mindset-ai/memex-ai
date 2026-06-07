// Specky — the voice guide's animated-paperclip character (spec-197).
//
// Renders the self-contained animated SVG (idle wobble/glance/blink) as a
// plain <img> sourced from a bundler-resolved URL (dec-3 / ac-10): NO inline
// parameterised SVG, NO Lottie, NO JS animation runtime. The idle loop AND the
// `prefers-reduced-motion` static-frame fallback both live inside the SVG
// itself (dec-1=a idle-only, dec-5=b reduced-motion), so this component stays
// presentation-only and needs no animation code.
//
// Because specky.svg is ~3.7KB (under Vite's ~4KB assetsInlineLimit), the
// import resolves to an inlined `data:image/svg+xml,...` URI rather than an
// emitted /assets/ file — which is even more deploy-safe (a data URI needs no
// LB routing at all). If the asset ever grows past the inline limit, Vite emits
// it under /assets/ instead, which the LB url-map already routes. Either way it
// is never a hardcoded web-root path like /specky.svg (which would 404 — see
// dec-3 / the Architecture section of spec-197).
//
// Per dec-1=a there are deliberately NO session-state variants
// (listening/thinking/speaking/ducked) — session state is conveyed by the
// spec-190 pill's own affordances, not by Specky. The same component serves
// both the small in-view mark and the larger pill avatar; callers size it.
//
// Wiring note (held until spec-190 merges): this is consumed as spec-190
// VoiceIcon's `mark` prop and as the session-pill avatar — see spec-197 t-2/t-3.

import speckyUrl from '../assets/specky.svg';

/** Intrinsic aspect ratio of specky.svg (viewBox "0 0 240 330"). */
const SPECKY_ASPECT = 330 / 240;

export interface SpeckyProps {
  /**
   * Rendered width in px. Height is derived from the SVG's intrinsic aspect
   * ratio so Specky scales crisply and never distorts at any size (ac-3).
   * Defaults to 48 (a mid size between the in-view mark and the pill avatar).
   */
  size?: number;
  /**
   * Accessible name. Defaults to '' (decorative) so Specky does not
   * double-announce when nested inside an already-labelled control such as the
   * spec-190 VoiceIcon. Pass a label when Specky stands alone as the avatar.
   */
  alt?: string;
  className?: string;
}

export function Specky({ size = 48, alt = '', className }: SpeckyProps) {
  return (
    <img
      src={speckyUrl}
      alt={alt}
      width={size}
      height={Math.round(size * SPECKY_ASPECT)}
      className={className}
      draggable={false}
    />
  );
}

export default Specky;
