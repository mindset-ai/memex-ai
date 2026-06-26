// spec-372 issue-17 — the shared "✓ <label>" done badge.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { StepDoneBadge } from './StepDoneBadge';

const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

describe('StepDoneBadge (spec-372 issue-17)', () => {
  it('renders a green pill with a ✓ check and the label', () => {
    tagAc(AC372(46));
    render(<StepDoneBadge label="Created" testId="badge" />);
    const badge = screen.getByTestId('badge');
    expect(badge.textContent).toContain('✓');
    expect(badge.textContent).toContain('Created');
    // pill styling modelled on the MCP "Connected" badge
    expect(badge.className).toContain('rounded-full');
    expect(badge.className).toContain('bg-status-success-bg');
    expect(badge.className).toContain('text-status-success-text');
  });
});
