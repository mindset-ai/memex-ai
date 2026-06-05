import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';

// spec-129 dec-8 (t-12) ac-22: a member-visible "Memex keys" entry exists in the account
// menu, SEPARATE from the admin-only "Memex settings" entry. A plain member sees "Memex
// keys" but not "Memex settings"; an admin sees both; a visited read-only viewer sees
// neither.
const AC_22 = 'mindset-prod/memex-building-itself/specs/spec-129/acs/ac-22';

type Membership = {
  memexId: string;
  slug: string;
  memexSlug: string;
  name: string;
  memexName: string;
  kind: 'team' | 'personal';
  role: 'administrator' | 'member';
  source?: 'org' | 'visited';
  accessLevel?: 'read' | 'write';
};

const BASE: Membership = {
  memexId: 'm1',
  slug: 'acme',
  memexSlug: 'team',
  name: 'Acme Inc',
  memexName: 'Team',
  kind: 'team',
  role: 'member',
  source: 'org',
  accessLevel: 'write',
};

// Mutable session the AuthContext mock reads — each test sets `session.memberships`.
const session: { user: unknown; memberships: Membership[]; currentMemexId: string } = {
  user: { name: 'Tester', email: 't@acme.test' },
  memberships: [BASE],
  currentMemexId: 'm1',
};

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Tester', email: 't@acme.test' },
    session,
    logout: vi.fn(),
  }),
}));

vi.mock('./MemexSwitcher', () => ({
  MemexSwitcher: () => <div data-testid="memex-switcher" />,
}));

vi.mock('./InviteMembersDialog', () => ({
  InviteMembersDialog: () => <div data-testid="invite-dialog" />,
}));

vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ isAuthenticated: true, isVisitedReadOnly: false }),
}));

vi.mock('../hooks/useDriftInboxCount', () => ({
  useDriftInboxCount: () => 0,
}));

import { AppShell } from './AppShell';

function renderShell() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/acme/team/specs']}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('spec-129 dec-8: "Memex keys" account-menu entry (ac-22)', () => {
  beforeEach(() => {
    session.memberships = [BASE];
    session.currentMemexId = 'm1';
  });

  it('a plain member sees "Memex keys" (→ /keys) but NOT "Memex settings"', () => {
    tagAc(AC_22);
    session.memberships = [{ ...BASE, role: 'member' }];
    renderShell();
    fireEvent.click(screen.getByText('Tester'));

    const keys = screen.getByRole('link', { name: 'Memex keys' });
    expect(keys).toHaveAttribute('href', '/acme/team/keys');
    expect(screen.queryByRole('link', { name: 'Memex settings' })).not.toBeInTheDocument();
  });

  it('an administrator sees BOTH "Memex keys" and "Memex settings"', () => {
    tagAc(AC_22);
    session.memberships = [{ ...BASE, role: 'administrator' }];
    renderShell();
    fireEvent.click(screen.getByText('Tester'));

    expect(screen.getByRole('link', { name: 'Memex keys' })).toHaveAttribute(
      'href',
      '/acme/team/keys',
    );
    expect(screen.getByRole('link', { name: 'Memex settings' })).toHaveAttribute(
      'href',
      '/acme/team/settings',
    );
  });

  it('a visited read-only viewer sees NEITHER entry', () => {
    tagAc(AC_22);
    session.memberships = [
      { ...BASE, role: 'member', source: 'visited', accessLevel: 'read' },
    ];
    renderShell();
    fireEvent.click(screen.getByText('Tester'));

    expect(screen.queryByRole('link', { name: 'Memex keys' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Memex settings' })).not.toBeInTheDocument();
  });
});
