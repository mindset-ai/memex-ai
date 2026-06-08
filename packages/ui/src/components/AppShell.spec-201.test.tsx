import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';

// spec-201 dec-1: the Integrations entry (which hosts the install instructions)
// must stay member-visible — not gated on administrator — so coders who connect
// agents can reach it.
const AC_MEMBER_VISIBLE = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-8';

// A plain (non-admin) team MEMBER membership matching the tenant in the URL.
const TEAM_MEMBER = {
  memexId: 'm1',
  slug: 'acme',
  memexSlug: 'team',
  name: 'Acme Inc',
  memexName: 'Team',
  kind: 'team' as const,
  role: 'member' as const,
};

const session = {
  user: { name: 'Member', email: 'm@acme.test' },
  memberships: [TEAM_MEMBER],
  currentMemexId: 'm1',
};

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Member', email: 'm@acme.test' },
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
    </ThemeProvider>
  );
}

describe('spec-201 ac-8: Integrations entry is member-visible', () => {
  it('shows the Integrations link in the user menu for a non-admin member', () => {
    tagAc(AC_MEMBER_VISIBLE);
    renderShell();
    fireEvent.click(screen.getByText('Member'));

    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'href',
      '/settings/integrations'
    );
    // It is NOT behind the admin-only gate (Org configuration is admin-gated and
    // must be absent for a plain member).
    expect(screen.queryByRole('link', { name: 'Org configuration' })).toBeNull();
  });
});
