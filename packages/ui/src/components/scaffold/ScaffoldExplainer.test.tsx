// spec-360 issue-9 — the scaffold empty-state explainer. It leads with "The
// scaffold assistant" (purpose: navigate + explain; admins propose org guidance
// via propose-then-approve), adds a "Handoffs" section, and carries a role badge
// driven by the optional `isAdmin` prop:
//   isAdmin=true      → badge data-role='admin'  + "you can edit" copy
//   isAdmin=false     → badge data-role='viewer' + view-only copy
//   isAdmin=undefined → no badge (capability not yet resolved)

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ScaffoldExplainer } from './ScaffoldExplainer';

// ac-11 (implementation): explain is open to any member; authoring affordances
// (the propose flow) render only for admins. The badge + copy express that.
const AC = 'mindset-prod/memex-building-itself/specs/spec-360/acs/ac-11';

describe('ScaffoldExplainer — role badge (issue-9, ac-11)', () => {
  it('isAdmin=true → badge data-role="admin" with editing copy', () => {
    tagAc(AC);
    render(<ScaffoldExplainer isAdmin />);
    const badge = screen.getByTestId('scaffold-role-badge');
    expect(badge).toHaveAttribute('data-role', 'admin');
    expect(badge).toHaveTextContent(/can edit guidance/i);
  });

  it('isAdmin=false → badge data-role="viewer" with view-only copy', () => {
    tagAc(AC);
    render(<ScaffoldExplainer isAdmin={false} />);
    const badge = screen.getByTestId('scaffold-role-badge');
    expect(badge).toHaveAttribute('data-role', 'viewer');
    expect(badge).toHaveTextContent(/view only/i);
  });

  it('isAdmin undefined → no badge (capability not resolved)', () => {
    tagAc(AC);
    render(<ScaffoldExplainer />);
    expect(screen.queryByTestId('scaffold-role-badge')).not.toBeInTheDocument();
  });
});

describe('ScaffoldExplainer — assistant + handoffs sections (issue-9, ac-11)', () => {
  it('renders the "The scaffold assistant" heading', () => {
    tagAc(AC);
    render(<ScaffoldExplainer isAdmin />);
    expect(
      screen.getByRole('heading', { name: 'The scaffold assistant' }),
    ).toBeInTheDocument();
  });

  it('renders the "Handoffs" heading', () => {
    tagAc(AC);
    render(<ScaffoldExplainer isAdmin />);
    expect(screen.getByRole('heading', { name: 'Handoffs' })).toBeInTheDocument();
  });
});
