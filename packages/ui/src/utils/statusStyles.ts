/**
 * Canonical status → color mapping for the entire React UI.
 * Uses design-token Tailwind classes — works in both themes with zero isDark checks.
 *
 * Usage:
 *   <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${statusClasses('open')}`}>open</span>
 *
 * Or use the Badge component from components/ui/ which wraps this utility.
 */

export type StatusVariant = 'warning' | 'success' | 'info' | 'danger' | 'neutral';

/** Maps a domain status string to a semantic StatusVariant. */
export function statusVariant(status: string): StatusVariant {
  switch (status) {
    // `review` is kept for non-Spec docTypes (per dec-3 of doc-10).
    // `specify` is the Spec rename of `review` and gets the same warning variant.
    case 'review':
    case 'specify':
    case 'open':
      return 'warning';
    // `verify` is green per spec-159 dec-3 — the acceptance gate reads as a
    // success-class state, distinct from the in-flight `build` (info).
    case 'verify':
    case 'done':
    case 'resolved':
    case 'complete':
    case 'approved':
      return 'success';
    // `implementation` is kept for non-Spec docTypes; `build` is the Spec rename.
    case 'implementation':
    case 'build':
    case 'in_progress':
      return 'info';
    case 'blocked':
    case 'error':
      return 'danger';
    case 'draft':
    case 'not_started':
    case 'pending':
    default:
      return 'neutral';
  }
}

const variantClasses: Record<StatusVariant, string> = {
  warning: 'bg-status-warning-bg text-status-warning-text border-status-warning-border',
  success: 'bg-status-success-bg text-status-success-text border-status-success-border',
  info:    'bg-status-info-bg text-status-info-text border-status-info-border',
  danger:  'bg-status-danger-bg text-status-danger-text border-status-danger-border',
  neutral: 'bg-status-neutral-bg text-status-neutral-text border-status-neutral-border',
};

const variantTextClasses: Record<StatusVariant, string> = {
  warning: 'text-status-warning-text',
  success: 'text-status-success-text',
  info:    'text-status-info-text',
  danger:  'text-status-danger-text',
  neutral: 'text-status-neutral-text',
};

/** Returns the Tailwind class string for a given domain status (bg + text + border). */
export function statusClasses(status: string): string {
  return variantClasses[statusVariant(status)];
}

/** Returns only the text-color Tailwind class for a given domain status. */
export function statusTextClass(status: string): string {
  return variantTextClasses[statusVariant(status)];
}
