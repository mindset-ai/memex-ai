// Canonical comment-type → color mapping for the React UI. Mirrors the colour palette in
// Section 7 of doc-10. Each entry maps a CommentType to:
//   - `pillClass`     — Tailwind classes applied to <CommentTypePill> (bg + text).
//   - `accentBorder`  — left-border accent applied when an agent posted the comment.
//   - `label`         — short label shown inside the pill (uppercase, replaces `_` with ` `).
//
// We use Tailwind's named palette directly here rather than the design-token shim used by
// statusStyles.ts because the spec calls out specific hues (indigo / amber / emerald / etc.)
// and we want them visually distinct in both light and dark themes. The "classes" shape is
// hand-written so Tailwind's compiler can statically pick up every variant (no template
// concatenation at render time).

import type { CommentType } from '../api/types';

interface CommentTypeStyle {
  /** Tailwind classes for the pill background + text colour. */
  pillClass: string;
  /** Tailwind class string for a left accent border (used for agent-source comments). */
  accentBorder: string;
  /** Display label for the pill — short, uppercase, human-readable. */
  label: string;
}

// Colour-coding per Section 7:
//   plan → indigo, progress → slate, issue → amber, deferred → zinc,
//   cross_reference → purple, question → red, review → blue,
//   readiness_check → emerald, approval → green, plan_revision → sky,
//   drift → orange, discussion → ghost/gray.
const STYLES: Record<CommentType, CommentTypeStyle> = {
  discussion: {
    pillClass: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    accentBorder: 'border-l-gray-400',
    label: 'Discussion',
  },
  plan: {
    pillClass: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
    accentBorder: 'border-l-indigo-500',
    label: 'Plan',
  },
  progress: {
    pillClass: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
    accentBorder: 'border-l-slate-500',
    label: 'Progress',
  },
  issue: {
    pillClass: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200',
    accentBorder: 'border-l-amber-500',
    label: 'Issue',
  },
  deferred: {
    pillClass: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
    accentBorder: 'border-l-zinc-500',
    label: 'Deferred',
  },
  cross_reference: {
    pillClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200',
    accentBorder: 'border-l-purple-500',
    label: 'Cross-ref',
  },
  question: {
    pillClass: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
    accentBorder: 'border-l-red-500',
    label: 'Question',
  },
  review: {
    pillClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
    accentBorder: 'border-l-blue-500',
    label: 'Review',
  },
  readiness_check: {
    pillClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
    accentBorder: 'border-l-emerald-500',
    label: 'Readiness',
  },
  approval: {
    pillClass: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
    accentBorder: 'border-l-green-500',
    label: 'Approval',
  },
  plan_revision: {
    pillClass: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
    accentBorder: 'border-l-sky-500',
    label: 'Plan rev.',
  },
  drift: {
    pillClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
    accentBorder: 'border-l-orange-500',
    label: 'Drift',
  },
};

/** Look up the style record for a CommentType. Falls back to `discussion`. */
export function commentTypeStyle(type: CommentType | undefined | null): CommentTypeStyle {
  if (!type) return STYLES.discussion;
  return STYLES[type] ?? STYLES.discussion;
}

/** Convenience: just the pill class string. */
export function commentTypePillClass(type: CommentType | undefined | null): string {
  return commentTypeStyle(type).pillClass;
}

/** Convenience: just the accent-border class string. */
export function commentTypeAccentBorder(type: CommentType | undefined | null): string {
  return commentTypeStyle(type).accentBorder;
}

/** Convenience: just the label. */
export function commentTypeLabel(type: CommentType | undefined | null): string {
  return commentTypeStyle(type).label;
}

// spec-153 / spec-185: the human composer no longer offers a comment-type picker
// and the human-facing comment-type filter chips have been removed — humans write
// and read freeform `discussion` comments. The typed taxonomy (STYLES above) remains
// an internal agent/system channel (drift / plan_revision / readiness_check / …) and
// drives only the per-type rendering pills of existing rows.
