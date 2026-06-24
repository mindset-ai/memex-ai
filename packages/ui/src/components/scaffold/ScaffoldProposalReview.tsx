// spec-360 t-4 (dec-2/dec-4): the propose-then-confirm review card.
//
// When the scaffold assistant drafts a change, the timeline navigates to the
// target circumstance (so the detail pane shows the TRUE current composition)
// and THIS card renders the drafted change composed in place — an ADD appears as
// a pending "your team" segment; an EDIT/DISABLE/ENABLE/DELETE shows the
// before/after. The admin approves or rejects HERE (dec-4); only on approve does
// the existing admin-gated route perform the write (ac-2). Nothing the assistant
// does writes silently.

import { useState } from 'react';
import { describeScaffoldTarget, type ScaffoldProposal } from '@memex/shared';
import { MarkdownText } from './MarkdownText';

interface Props {
  proposal: ScaffoldProposal;
  /** Performs the write through the existing admin-gated route. Throws on error. */
  onApprove: (proposal: ScaffoldProposal) => Promise<void>;
  /** Discards the proposal — nothing is written. */
  onReject: () => void;
}

function verb(op: ScaffoldProposal['operation']): string {
  switch (op) {
    case 'add':
      return 'Add';
    case 'edit':
      return 'Edit';
    case 'disable':
      return 'Disable';
    case 'enable':
      return 'Enable';
    case 'delete':
      return 'Delete';
  }
}

export function ScaffoldProposalReview({ proposal, onApprove, onReject }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = proposal.target ?? proposal.before?.target ?? {};

  async function approve() {
    setError(null);
    setSubmitting(true);
    try {
      await onApprove(proposal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply the change');
      setSubmitting(false);
    }
  }

  return (
    <section
      data-testid="scaffold-proposal-review"
      data-operation={proposal.operation}
      className="rounded-lg border border-amber-400/50 bg-amber-50/5 p-4 space-y-3"
    >
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-500">
            Proposed · {verb(proposal.operation)}
          </span>
          <span className="text-xs text-secondary">applies {describeScaffoldTarget(target)}</span>
          {/* spec-360: scope of a NEW addition — org-wide vs this Memex only. */}
          {proposal.operation === 'add' ? (
            <span
              data-testid="scaffold-proposal-scope"
              className="inline-flex items-center rounded-full border border-edge px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-secondary"
            >
              {proposal.scope === 'memex' ? 'This Memex only' : 'Org-wide'}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-heading font-medium">{proposal.summary}</p>
      </header>

      {/* The change, composed in place. */}
      <div data-testid="scaffold-proposal-preview" className="space-y-2">
        {proposal.operation === 'add' ? (
          <div
            data-testid="scaffold-proposal-pending-segment"
            className="rounded-lg border border-dashed border-amber-400/60 bg-surface p-4 space-y-2"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">
              Your org (pending)
            </div>
            <MarkdownText text={proposal.text ?? ''} />
          </div>
        ) : null}

        {proposal.operation === 'edit' ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-edge bg-surface p-4 space-y-2 opacity-70">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Before</div>
              <MarkdownText text={proposal.before?.text ?? ''} />
            </div>
            <div className="rounded-lg border border-amber-400/60 bg-surface p-4 space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">After</div>
              <MarkdownText text={proposal.text ?? ''} />
            </div>
          </div>
        ) : null}

        {proposal.operation === 'disable' || proposal.operation === 'enable' ? (
          <div className="rounded-lg border border-edge bg-surface p-4 space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              {proposal.before?.enabled ? 'Currently enabled' : 'Currently disabled'} →{' '}
              {proposal.operation === 'enable' ? 'will be enabled' : 'will be disabled'}
            </div>
            <MarkdownText text={proposal.before?.text ?? ''} />
          </div>
        ) : null}

        {proposal.operation === 'delete' ? (
          <div className="rounded-lg border border-red-500/40 bg-surface p-4 space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-red-500">
              Will be removed
            </div>
            <MarkdownText text={proposal.before?.text ?? ''} />
          </div>
        ) : null}
      </div>

      {error ? (
        <div data-testid="scaffold-proposal-error" className="text-xs text-red-600">
          {error}
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="scaffold-proposal-approve"
          disabled={submitting}
          onClick={approve}
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-1 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          {submitting ? 'Applying…' : 'Approve & apply'}
        </button>
        <button
          type="button"
          data-testid="scaffold-proposal-reject"
          disabled={submitting}
          onClick={onReject}
          className="rounded-md border border-default px-3 py-1 text-sm hover:bg-overlay disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </section>
  );
}
