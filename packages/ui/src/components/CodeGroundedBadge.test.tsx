// spec-409 (ac-1) — the Code-grounded badge renders the grounded / stale /
// not-grounded states a reader sees on the Spec page and the board card.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { CodeGroundedBadge } from './CodeGroundedBadge';

const AC1 = 'mindset-prod/memex-building-itself/specs/spec-409/acs/ac-1';

describe('CodeGroundedBadge (spec-409 ac-1)', () => {
  it('renders the grounded mark when grounded and not stale', () => {
    tagAc(AC1);
    render(<CodeGroundedBadge groundedInCode groundedBy="Barrie" groundedAt="25 Jun 2026" />);
    const badge = screen.getByTestId('code-grounded-badge');
    expect(badge).toHaveAttribute('data-state', 'grounded');
    expect(badge).toHaveTextContent(/code-grounded/i);
    expect(badge.getAttribute('title')).toContain('Barrie');
  });

  it('renders the stale state when a decision/AC changed since grounding', () => {
    tagAc(AC1);
    render(<CodeGroundedBadge groundedInCode groundedStale />);
    const badge = screen.getByTestId('code-grounded-badge');
    expect(badge).toHaveAttribute('data-state', 'stale');
    expect(badge).toHaveTextContent(/stale/i);
  });

  it('renders nothing when the Spec is not grounded', () => {
    tagAc(AC1);
    const { container } = render(<CodeGroundedBadge groundedInCode={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('compact card variant shows the glyph but no text label', () => {
    tagAc(AC1);
    render(<CodeGroundedBadge groundedInCode compact />);
    const badge = screen.getByTestId('code-grounded-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).not.toHaveTextContent(/code-grounded/i);
  });
});
