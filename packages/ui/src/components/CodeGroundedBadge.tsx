// spec-409 (ac-1) — the verification-style "Code-grounded" badge. Renders on the
// Spec page header and (compact) on the board card so a reader can tell at a
// glance whether a Spec's decisions were checked against the actual code.
//
// The mark is a solid verification SEAL (the scalloped "verified" shape + check),
// not a faint pill — so it reads instantly, like a verified-account badge.
//
// Three states (dec-4):
//   - grounded (flag true, not stale) → solid emerald seal + "Code-grounded".
//   - stale (grounded but a decision/AC changed since) → amber seal + "· stale".
//   - not grounded → renders nothing (the absence IS the signal; the page-level
//     call-to-action lives elsewhere).
//
// `compact` drops the label + pill to just the solid seal, for the dense board card.

interface CodeGroundedBadgeProps {
  groundedInCode: boolean;
  /** True when grounded but a decision/AC changed since groundedAt (read-time). */
  groundedStale?: boolean;
  /** Card variant: seal only, no text label / pill. */
  compact?: boolean;
  /** Provenance for the tooltip, e.g. "Barrie on 25 Jun 2026". */
  groundedBy?: string | null;
  groundedAt?: string | null;
  className?: string;
}

/** The verification seal — scalloped "verified" disc (accent fill) + white check. */
function VerifiedSeal({ size, className = '' }: { size: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={className}>
      {/* scalloped seal — solid accent (currentColor) */}
      <path
        fill="currentColor"
        d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34z"
      />
      {/* check — white knockout */}
      <path
        fill="#fff"
        d="M9.71 16.63 6.3 13.22a.996.996 0 1 1 1.41-1.41l2.0 2.0 5.18-5.18a.996.996 0 1 1 1.41 1.41l-5.89 5.89a1 1 0 0 1-1.41 0z"
      />
    </svg>
  );
}

export function CodeGroundedBadge({
  groundedInCode,
  groundedStale = false,
  compact = false,
  groundedBy,
  groundedAt,
  className = '',
}: CodeGroundedBadgeProps) {
  if (!groundedInCode) return null;

  const stale = groundedStale;
  // Grounded uses the build-phase blue (the `info` status variant — same token as
  // the build kanban column / status pill). Stale keeps an amber drift tint.
  const styles = stale
    ? { seal: 'text-amber-500', label: 'text-amber-700 dark:text-amber-300', pill: 'bg-amber-500/10 border-amber-500/30' }
    : { seal: 'text-status-info-text', label: 'text-status-info-text', pill: 'bg-status-info-bg border-status-info-border' };

  const label = stale ? 'Code-grounded · stale' : 'Code-grounded';
  const provenance =
    groundedBy != null
      ? `Grounded in code by ${groundedBy}${groundedAt ? ` on ${groundedAt}` : ''}${stale ? ' — changed since, re-ground' : ''}`
      : stale
        ? 'Grounded in code, but a decision or AC changed since — re-ground'
        : 'Grounded in code';

  if (compact) {
    return (
      <span
        data-testid="code-grounded-badge"
        data-state={stale ? 'stale' : 'grounded'}
        title={provenance}
        aria-label={provenance}
        className={`inline-flex ${className}`}
      >
        <VerifiedSeal size={16} className={styles.seal} />
      </span>
    );
  }

  return (
    <span
      data-testid="code-grounded-badge"
      data-state={stale ? 'stale' : 'grounded'}
      title={provenance}
      aria-label={provenance}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-none ${styles.pill} ${styles.label} ${className}`}
    >
      <VerifiedSeal size={14} className={styles.seal} />
      <span>{label}</span>
    </span>
  );
}
