// spec-222 t-5 (ac-7) — the engine chunk's self-contained shadow-root stylesheet.
//
// The session UI (VoiceSessionPill, VoiceIcon, Specky avatar, the recovery card)
// is authored with the app's Tailwind utility classes + design-token CSS vars
// (e.g. `bg-surface`, `ring-border`, `text-sm`). In the app those resolve against
// a global Tailwind sheet; INSIDE the bundle's shadow root there is no Tailwind and
// host CSS can't reach in (ac-7). So every class the components use would be inert
// and the guide would render as raw browser-default boxes.
//
// This module ships the missing styles WITH the engine chunk (it's imported by
// engine.tsx, so it rides the lazily-fetched engine split — never the thin loader,
// preserving the ac-8 cut). mountEngine() injects ENGINE_CSS as a <style> into the
// same shadow root the loader created. It does TWO things:
//
//   1. Declares the app's design tokens on :host (the dark theme — the app is
//      dark-by-default: `<html class="dark">`). Values are copied verbatim from
//      packages/ui/src/index.css `.dark` so the embedded guide matches the app.
//   2. Hand-implements EXACTLY the Tailwind utility classes the rendered
//      components use — no Tailwind build, just the literal declarations — so the
//      pill, icon and recovery card look on-brand on a bare static page.
//
// The components keep their app class names (no component rewrites); this sheet is
// the single place the shadow scope learns what those classes mean.

export const ENGINE_CSS = `
:host {
  /* ── Design tokens (dark theme, verbatim from packages/ui/src/index.css .dark) ── */
  --color-surface: 27 30 36;          /* #1b1e24 */
  --color-card-hover: 40 44 52;       /* #282c34 — the app's surface-hover */
  --color-text-primary: 226 232 240;  /* slate-200 */
  --color-text-secondary: 148 163 184;/* slate-400 */
  --color-edge: 62 68 81;             /* #3e4451 — the app's border colour */
  --color-accent: 96 165 250;         /* blue-400 */

  /* A coherent type baseline so the guide doesn't inherit the host page's font. */
  color: rgb(var(--color-text-primary));
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
  font-size: 14px;
  line-height: 1.4;
}

/* Reset the engine container's inherited box model (host pages vary wildly). */
:where([data-memex-guide='engine'] *),
:where([data-memex-guide='engine'] *)::before,
:where([data-memex-guide='engine'] *)::after {
  box-sizing: border-box;
}

/* Buttons inside the engine shed the host page's button chrome before our
   utility classes paint them (background/border/font come from the classes).
   :where() zeroes the reset's specificity — bare, this selector is (0,1,1)
   and its background: none beats every single-class utility like .bg-surface
   (0,1,0), leaving the idle icon and pill transparent on the host page (the
   doorway-dark-then-light bug seen live on www.memex.ai). */
:where([data-memex-guide='engine'] button) {
  margin: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
}

/* ── Layout ── */
.flex { display: flex; }
.inline-block { display: inline-block; }
.block { display: block; }
.items-center { align-items: center; }
.justify-center { justify-content: center; }
.gap-1 { gap: 0.25rem; }
.gap-2 { gap: 0.5rem; }
.ml-1 { margin-left: 0.25rem; }
.mt-2 { margin-top: 0.5rem; }

/* ── Sizing ── */
.h-2\\.5 { height: 0.625rem; }
.w-2\\.5 { width: 0.625rem; }
.h-3 { height: 0.75rem; }
.w-3 { width: 0.75rem; }
.h-6 { height: 1.5rem; }
.w-6 { width: 1.5rem; }
.h-16 { height: 4rem; }
.w-16 { width: 4rem; }
.max-w-xs { max-width: 20rem; }

/* ── Spacing (padding) ── */
.p-1 { padding: 0.25rem; }
.p-3 { padding: 0.75rem; }
.px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
.px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
.py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
.py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }

/* ── Radii ── */
.rounded-\\[2px\\] { border-radius: 2px; }
.rounded-md { border-radius: 0.375rem; }
.rounded-lg { border-radius: 0.5rem; }
.rounded-full { border-radius: 9999px; }

/* ── Surfaces / fills ── */
.bg-surface { background-color: rgb(var(--color-surface)); }
.bg-accent { background-color: rgb(var(--color-accent)); }
.bg-current { background-color: currentColor; }
.bg-amber-400 { background-color: rgb(251 191 36); }
.bg-emerald-400 { background-color: rgb(52 211 153); }

/* ── Text ── */
.text-sm { font-size: 0.875rem; line-height: 1.25rem; }
.text-white { color: rgb(255 255 255); }
.text-accent { color: rgb(var(--color-accent)); }
.text-text-primary { color: rgb(var(--color-text-primary)); }
.text-text-secondary { color: rgb(var(--color-text-secondary)); }

/* ── Borders / rings (the app uses ring-1 ring-border for the hairline edge) ── */
.ring-1 { box-shadow: 0 0 0 1px rgb(var(--color-edge)); }
/* ring-border is the components' class name; map it to the real edge token so the
   hairline matches the app (tailwind.config.js exposes the token as 'edge'). */
.ring-border { --tw-ring-color: rgb(var(--color-edge)); }

/* ── Elevation ── */
.shadow-lg {
  box-shadow:
    0 10px 15px -3px rgba(0, 0, 0, 0.35),
    0 4px 6px -4px rgba(0, 0, 0, 0.35);
}
/* ring-1 + shadow-lg co-occur on the pill/icon/card; compose the hairline ring
   AND the drop shadow so neither box-shadow clobbers the other. */
.ring-1.shadow-lg,
.shadow-lg.ring-1 {
  box-shadow:
    0 0 0 1px rgb(var(--color-edge)),
    0 10px 15px -3px rgba(0, 0, 0, 0.35),
    0 4px 6px -4px rgba(0, 0, 0, 0.35);
}

/* ── Opacity ── */
.opacity-70 { opacity: 0.7; }

/* ── Transition + interaction (the icon's hover-grow + disabled states) ── */
.transition {
  transition-property: color, background-color, border-color, transform, opacity, box-shadow;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  transition-duration: 150ms;
}
.hover\\:scale-105:hover { transform: scale(1.05); }
.hover\\:bg-surface-hover:hover { background-color: rgb(var(--color-card-hover)); }
button:disabled.disabled\\:opacity-40 { opacity: 0.4; }
button:disabled.disabled\\:hover\\:scale-100:hover { transform: scale(1); }

/* ── Motion: the StateBlip / requesting-mark pulse (Tailwind's animate-pulse) ── */
.animate-pulse { animation: memex-guide-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
@keyframes memex-guide-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
@media (prefers-reduced-motion: reduce) {
  .animate-pulse { animation: none; }
}
`;
