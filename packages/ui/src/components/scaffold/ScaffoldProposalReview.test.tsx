// spec-360 t-4 — the propose-then-confirm review card.
//
// **ac-9** — a proposal renders COMPOSED in place: an add shows a pending "your
// team" segment; an edit shows before/after; a delete shows what is removed.
// **ac-2** — approve performs the write (calls onApprove with the proposal);
// reject discards it (calls onReject); the card itself never writes silently.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import type { ScaffoldProposal } from '@memex/shared';
import { ScaffoldProposalReview } from './ScaffoldProposalReview';

const ac = (n: number) => `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

const ADD: ScaffoldProposal = {
  operation: 'add',
  target: { tool: 'create_task', phase: 'build' },
  text: 'Every build task must carry an acceptance criterion.',
  rationale: 'house rule',
  summary: 'Add org guidance when `create_task` runs during the build phase.',
};

describe('spec-360 t-4: proposal renders composed in place (ac-9)', () => {
  it('an ADD shows a pending "your team" segment with the drafted text', () => {
    tagAc(ac(9));
    render(<ScaffoldProposalReview proposal={ADD} onApprove={vi.fn()} onReject={vi.fn()} />);
    const review = screen.getByTestId('scaffold-proposal-review');
    expect(review).toHaveAttribute('data-operation', 'add');
    expect(screen.getByTestId('scaffold-proposal-pending-segment')).toHaveTextContent(
      'Every build task must carry an acceptance criterion.',
    );
    // and it states where it lands, in plain language
    expect(review).toHaveTextContent(/create_task/);
  });

  it('an EDIT shows before and after', () => {
    tagAc(ac(9));
    const edit: ScaffoldProposal = {
      operation: 'edit',
      blockId: 'b1',
      text: 'New text.',
      before: { text: 'Old text.' },
      summary: 'Edit the org guidance.',
    };
    render(<ScaffoldProposalReview proposal={edit} onApprove={vi.fn()} onReject={vi.fn()} />);
    const preview = screen.getByTestId('scaffold-proposal-preview');
    expect(preview).toHaveTextContent('Old text.');
    expect(preview).toHaveTextContent('New text.');
  });

  it('a DELETE shows what will be removed', () => {
    tagAc(ac(9));
    const del: ScaffoldProposal = {
      operation: 'delete',
      blockId: 'b1',
      before: { text: 'Doomed guidance.' },
      summary: 'Delete the org guidance.',
    };
    render(<ScaffoldProposalReview proposal={del} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByTestId('scaffold-proposal-preview')).toHaveTextContent('Doomed guidance.');
  });
});

// spec-360 issue-11 — the scope chip. A NEW addition (add) carries a scope:
// org-wide vs this-Memex-only. The chip shows the right label, and it only
// renders on an add proposal (an edit/disable/delete changes an existing block —
// its scope is fixed, so no chip).
describe('spec-360 issue-11: the scope chip on an add proposal (ac-2)', () => {
  it("scope 'memex' shows 'This Memex only'", () => {
    tagAc(ac(2));
    render(
      <ScaffoldProposalReview proposal={{ ...ADD, scope: 'memex' }} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(screen.getByTestId('scaffold-proposal-scope')).toHaveTextContent('This Memex only');
  });

  it("scope 'org' shows 'Org-wide'", () => {
    tagAc(ac(2));
    render(
      <ScaffoldProposalReview proposal={{ ...ADD, scope: 'org' }} onApprove={vi.fn()} onReject={vi.fn()} />,
    );
    expect(screen.getByTestId('scaffold-proposal-scope')).toHaveTextContent('Org-wide');
  });

  it("omitted scope defaults the chip to 'Org-wide'", () => {
    tagAc(ac(2));
    render(<ScaffoldProposalReview proposal={ADD} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByTestId('scaffold-proposal-scope')).toHaveTextContent('Org-wide');
  });

  it('the scope chip is absent on an EDIT proposal (only adds carry a scope)', () => {
    tagAc(ac(2));
    const edit: ScaffoldProposal = {
      operation: 'edit',
      blockId: 'b1',
      text: 'New text.',
      before: { text: 'Old text.' },
      scope: 'memex',
      summary: 'Edit the org guidance.',
    };
    render(<ScaffoldProposalReview proposal={edit} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.queryByTestId('scaffold-proposal-scope')).not.toBeInTheDocument();
  });
});

describe('spec-360 t-4: approve writes, reject discards (ac-2)', () => {
  it('approve calls onApprove with the proposal (the write path)', async () => {
    tagAc(ac(2));
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onReject = vi.fn();
    render(<ScaffoldProposalReview proposal={ADD} onApprove={onApprove} onReject={onReject} />);
    await userEvent.click(screen.getByTestId('scaffold-proposal-approve'));
    expect(onApprove).toHaveBeenCalledWith(ADD);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('reject calls onReject and never approves (nothing written)', async () => {
    tagAc(ac(2));
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ScaffoldProposalReview proposal={ADD} onApprove={onApprove} onReject={onReject} />);
    await userEvent.click(screen.getByTestId('scaffold-proposal-reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });
});
