import { useState, type CSSProperties } from 'react';

/**
 * spec-290 (dec-3 / ac-6, ac-10) — below-floor browser notice.
 *
 * Tailwind v4 targets Safari 16.4+ / Chrome 111+ / Firefox 128+ and our token
 * system routes every colour through `color-mix()` — so a below-floor browser
 * renders a broken UI with no fallback. We detect that with a single feature
 * probe (color-mix support stands in for "can render v4 CSS") and show an
 * unobtrusive upgrade notice instead of leaving the user staring at broken paint.
 *
 * The banner styles itself with ONLY baseline CSS (inline literal colours — no
 * design tokens, no color-mix, no @property), because the very capabilities it
 * detects as missing are the ones our token CSS depends on.
 */

/** True when the browser can render Tailwind v4's CSS (color-mix is the proxy). */
export function isModernCssSupported(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('color', 'color-mix(in srgb, red, blue)')
  );
}

const bar: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 2147483647,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '12px',
  padding: '10px 16px',
  // Baseline literal colours — high contrast, theme-agnostic, no tokens.
  background: '#0f172a', // slate-900
  color: '#f8fafc', // slate-50 (~17:1 on slate-900)
  borderBottom: '2px solid #f59e0b', // amber-500 accent
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: '14px',
  lineHeight: 1.4,
};

const dismissBtn: CSSProperties = {
  flex: '0 0 auto',
  background: 'transparent',
  color: '#f8fafc',
  border: '1px solid #f8fafc',
  borderRadius: '4px',
  padding: '2px 10px',
  fontSize: '13px',
  cursor: 'pointer',
};

export function UnsupportedBrowserBanner() {
  // Evaluate once at mount — the browser's capabilities don't change mid-session.
  const [supported] = useState(isModernCssSupported);
  const [dismissed, setDismissed] = useState(false);

  if (supported || dismissed) return null;

  return (
    <div role="status" aria-live="polite" style={bar} data-testid="unsupported-browser-banner">
      <span>
        Your browser is out of date and may not display this app correctly. Please
        update to a recent version of Chrome, Safari, Firefox or Edge.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss browser warning"
        style={dismissBtn}
      >
        Dismiss
      </button>
    </div>
  );
}
