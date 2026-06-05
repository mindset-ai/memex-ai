// spec-100: the floating toolbar that appears when text is selected in a
// section body (Google-Docs style). A compact icon-only pill, theme-aware via
// the semantic tokens (so it inverts in dark mode). v1 carries a single action,
// Comment; the pill is built as a row of icon slots with hairline dividers so
// future actions (edit, AI) drop in beside it.

interface SelectionToolbarProps {
  /** Fixed-position coordinates (viewport) for the pill's top-centre. */
  top: number;
  left: number;
  onComment: () => void;
}

export function SelectionToolbar({ top, left, onComment }: SelectionToolbarProps) {
  return (
    <div
      data-testid="selection-toolbar"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()} // keep the text selection alive on click
      style={{ position: 'fixed', top, left, transform: 'translateX(-50%)', zIndex: 50 }}
      className="flex items-center rounded-xl border border-edge-subtle bg-surface shadow-lg px-1 py-1"
    >
      <button
        type="button"
        data-testid="selection-toolbar-comment"
        onClick={onComment}
        title="Comment on selection"
        aria-label="Comment on selection"
        className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-primary hover:bg-card-hover transition-colors"
      >
        {/* speech bubble with a plus inside */}
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v5.25M9.375 10.875h5.25" />
        </svg>
      </button>
    </div>
  );
}
