import { useState } from 'react';
import type { DriftProposal, DriftProposalOperation } from '../../api/client';

/**
 * The before/after a Drift Inbox proposal row promises (spec-530 t-7).
 *
 * The row used to claim, in its own header comment, that the diff was "reachable via
 * Discuss with Agent or the standard page". Verified 2026-08-13: it was reachable via
 * neither. `proposedContent` was fetched to the client and rendered by nothing, so a
 * user judging a proposal had no way to see what it actually said.
 *
 * **Collapsed by default, and collapsed means NOT RENDERED — not hidden with CSS.**
 * spec-498 deliberately took the heavy diff out of the list ("the important information
 * at a glance, not a wall of text") and pinned that with tests asserting the diff
 * element is absent. Those tests stay green here, unchanged: nothing of the diff enters
 * the DOM until the reader asks for it. A 12-operation proposal is therefore still one
 * scannable line in the list, which is the only way dec-1's operation SETS could live on
 * this surface at all.
 *
 * **Read-only.** No Accept / Reject / Resolve control — spec-143 dec-3 removed those
 * deliberately, on the grounds that accepting a proposal is a judgement rather than a
 * one-click yes/no, and spec-530's non-goals explicitly decline to revisit that. The
 * reader forms a view here and tells the agent; the agent applies it behind a
 * confirmation gate.
 */
export function ProposalDisclosure({ proposal }: { proposal: DriftProposal | null }) {
  const [open, setOpen] = useState(false);
  if (!proposal) return null;

  // A legacy or unreadable body has no operations to diff. Say so in one line rather
  // than dumping the body — an unapplicable row must cost one explanatory sentence, not
  // the wall of text spec-498 removed (spec-530 ac-18).
  if (proposal.kind !== 'clause-ops') {
    return (
      <p
        className="mt-2 text-xs text-muted"
        data-testid="drift-proposal-unapplicable"
        data-proposal-kind={proposal.kind}
      >
        {proposal.kind === 'legacy'
          ? 'This proposal predates the clause grain — it replaces a whole section, so it cannot be applied clause by clause. Ask the agent to restate it against the current rule.'
          : 'This proposal carries no readable changes, so it cannot be applied. Ask the agent to re-propose it.'}
      </p>
    );
  }

  const count = proposal.operations.length;
  const label = `${count} clause change${count === 1 ? '' : 's'}`;

  return (
    <div className="mt-2">
      <button
        type="button"
        // The row itself focuses the agent on click; expanding a diff must not also
        // fire that.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="text-xs px-2.5 py-1 rounded-full border border-edge bg-card-hover text-secondary hover:text-primary hover:border-accent transition-colors"
        data-testid="drift-proposal-toggle"
        data-open={open ? 'true' : 'false'}
      >
        {open ? 'Hide' : 'Show'} {label}
      </button>

      {open && (
        <div
          className="mt-3 space-y-3"
          data-testid="drift-proposal-diff"
          onClick={(e) => e.stopPropagation()}
        >
          {proposal.operations.map((op, i) => (
            <OperationDiff key={`${op.op}-${op.clause}-${i}`} op={op} />
          ))}
        </div>
      )}
    </div>
  );
}

const OP_LABEL: Record<DriftProposalOperation['op'], string> = {
  edit: 'Edit',
  add: 'Add',
  delete: 'Remove',
};

function OperationDiff({ op }: { op: DriftProposalOperation }) {
  return (
    <div
      className="border border-edge-subtle rounded-md p-3 bg-surface/40"
      data-testid="drift-proposal-operation"
      data-op={op.op}
      data-clause={op.clause}
    >
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-xs font-medium text-secondary">{OP_LABEL[op.op]}</span>
        {/* The cl-N is what the reader and the agent both name the target by
            [per std-10] — never "the second clause". */}
        <span className="font-mono text-xs text-muted" data-testid="drift-proposal-clause">
          {op.clause}
        </span>
        {op.op === 'add' && (
          <span className="text-xs text-muted">
            new clause {op.placement === 'before' ? 'before' : 'after'} it
          </span>
        )}
      </div>

      {/* An add's `current` is its ANCHOR's text — context for where the new clause
          lands, not something being replaced. */}
      {op.op === 'add' ? (
        <>
          {op.current !== null && (
            <Body kind="context" label="Anchored to" text={op.current} />
          )}
          {op.after !== undefined && <Body kind="proposed" label="New clause" text={op.after} />}
        </>
      ) : (
        <>
          {op.current === null ? (
            <p className="text-xs text-muted" data-testid="drift-proposal-clause-gone">
              This clause no longer exists on the Standard.
            </p>
          ) : (
            <Body kind="current" label="Now" text={op.current} />
          )}
          {op.op === 'edit' && op.after !== undefined && (
            <Body kind="proposed" label="Proposed" text={op.after} />
          )}
          {op.op === 'delete' && (
            <p className="mt-2 text-xs text-status-danger-text">Removed entirely.</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One side of a diff. The tints are the shared status tokens, so both themes are handled
 * by the token layer rather than by a palette invented here [per the design system].
 */
function Body({
  kind,
  label,
  text,
}: {
  kind: 'current' | 'proposed' | 'context';
  label: string;
  text: string;
}) {
  const tone =
    kind === 'proposed'
      ? 'bg-status-success-bg border-status-success-border text-status-success-text'
      : kind === 'current'
        ? 'bg-status-danger-bg border-status-danger-border text-status-danger-text'
        : 'border-edge-subtle text-muted';
  return (
    <div className="mt-2 first:mt-0" data-testid={`drift-proposal-${kind}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted mb-1">{label}</div>
      {/* whitespace-pre-wrap: clause bodies are markdown and their line breaks are
          meaningful. break-words so a long URL cannot widen the row. */}
      <div className={`border rounded-sm px-2 py-1.5 text-xs whitespace-pre-wrap break-words ${tone}`}>
        {text}
      </div>
    </div>
  );
}
