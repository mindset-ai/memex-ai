import type { Tag } from '../api/types';

interface TagChipProps {
  /**
   * The tag to render. Accepts a full `Tag` or any object carrying just the
   * load-bearing fields — `scope` (NULL = flat) and `value`. Tag text is USER
   * INPUT; it is rendered as escaped React text children (never
   * dangerouslySetInnerHTML), so `priority::<script>` is shown literally.
   */
  tag: Pick<Tag, 'scope' | 'value'>;
  /**
   * Optional remove affordance. When provided, a small × button renders on the
   * right and calls this on click. Omit for read-only display (cards, doc header).
   */
  onRemove?: () => void;
  /** Accessible label for the remove button. Defaults to `Remove tag <formatted>`. */
  removeLabel?: string;
  className?: string;
}

/**
 * A single tag rendered as a chip. Two visual forms (spec-136 t-5/ac-4):
 *   - SCOPED (`priority::high`): the scope is shown in a muted leading segment
 *     visually distinct from the value, joined by a `::` separator — so the
 *     reader parses "which axis / which value" at a glance.
 *   - FLAT (`bug`): a plain single-segment chip, no scope, no separator.
 *
 * Scope is distinguished by `scope === null`, NOT by string-sniffing the value —
 * a flat value may legitimately contain `::`-like text, and the server is the
 * source of truth for the split (parseTagInput). Styling uses the admin's design
 * tokens so it tracks both themes (matches the surrounding chip language).
 */
export function TagChip({ tag, onRemove, removeLabel, className = '' }: TagChipProps) {
  const isScoped = tag.scope !== null && tag.scope !== undefined;
  const formatted = isScoped ? `${tag.scope}::${tag.value}` : tag.value;

  return (
    <span
      data-testid="tag-chip"
      data-tag-scoped={isScoped ? 'true' : 'false'}
      title={formatted}
      className={`inline-flex items-center gap-0.5 overflow-hidden rounded-full border border-edge-subtle bg-surface text-[11px] font-medium leading-none text-secondary ${
        onRemove ? 'pl-2 pr-1 py-0.5' : 'px-2 py-0.5'
      } ${className}`}
    >
      {isScoped && (
        <>
          <span
            data-testid="tag-chip-scope"
            className="font-semibold uppercase tracking-wide text-accent"
          >
            {tag.scope}
          </span>
          <span aria-hidden="true" className="text-muted">
            ::
          </span>
        </>
      )}
      <span data-testid="tag-chip-value" className="truncate">
        {tag.value}
      </span>
      {onRemove && (
        <button
          type="button"
          data-testid="tag-chip-remove"
          aria-label={removeLabel ?? `Remove tag ${formatted}`}
          onClick={onRemove}
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted hover:bg-overlay hover:text-primary"
        >
          <span aria-hidden="true" className="text-[13px] leading-none">
            ×
          </span>
        </button>
      )}
    </span>
  );
}
