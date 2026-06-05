import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';

// spec-141 ACs verified here.
const AC_INVITE = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-2';
const AC_PROMOTE_DISCOVERY = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-5';
const AC_MENU = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-6';

type Membership = {
  memexId: string;
  slug: string;
  memexSlug: string;
  name: string;
  memexName: string;
  kind: 'team' | 'personal';
  role: 'administrator' | 'member';
};

// A team-admin membership matching the tenant in the test URL.
const TEAM_ADMIN: Membership = {
  memexId: 'm1',
  slug: 'acme',
  memexSlug: 'team',
  name: 'Acme Inc',
  memexName: 'Team',
  kind: 'team',
  role: 'administrator',
};

const session = {
  user: { name: 'Tester', email: 't@acme.test' },
  memberships: [TEAM_ADMIN],
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

// Stub the invite dialog so the test asserts AppShell's wiring (does the
// shortcut open it with the right tenant props?) without the dialog's own
// network calls.
vi.mock('./InviteMembersDialog', () => ({
  InviteMembersDialog: (p: {
    namespaceSlug: string;
    memexSlug: string;
    orgName: string;
    onClose: () => void;
  }) => (
    <div
      data-testid="invite-dialog"
      data-ns={p.namespaceSlug}
      data-mx={p.memexSlug}
      data-org={p.orgName}
    >
      <button onClick={p.onClose}>close-invite</button>
    </div>
  ),
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

describe('spec-141: sidebar invite shortcut + user-menu entries', () => {
  it('renders an invite shortcut (not a settings gear) for a team admin', () => {
    tagAc(AC_INVITE);
    renderShell();
    expect(screen.getByTestId('invite-members-shortcut')).toBeInTheDocument();
    expect(screen.queryByTestId('memex-settings-gear')).not.toBeInTheDocument();
  });

  it('opens InviteMembersDialog seeded with the current tenant + org name', () => {
    tagAc(AC_INVITE);
    renderShell();
    expect(screen.queryByTestId('invite-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('invite-members-shortcut'));

    const dialog = screen.getByTestId('invite-dialog');
    expect(dialog).toHaveAttribute('data-ns', 'acme');
    expect(dialog).toHaveAttribute('data-mx', 'team');
    expect(dialog).toHaveAttribute('data-org', 'Acme Inc');

    fireEvent.click(screen.getByText('close-invite'));
    expect(screen.queryByTestId('invite-dialog')).not.toBeInTheDocument();
  });

  it('exposes "Memex settings" (tenant-scoped) in the user menu', () => {
    tagAc(AC_MENU);
    renderShell();
    fireEvent.click(screen.getByText('Tester'));

    const settings = screen.getByRole('link', { name: 'Memex settings' });
    expect(settings).toHaveAttribute('href', '/acme/team/settings');
    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'href',
      '/settings/integrations'
    );
  });

  it('keeps Org configuration reachable from the user menu (promote discoverability)', () => {
    tagAc(AC_PROMOTE_DISCOVERY);
    renderShell();
    fireEvent.click(screen.getByText('Tester'));

    const orgConfig = screen.getByRole('link', { name: 'Org configuration' });
    expect(orgConfig).toHaveAttribute('href', '/acme/team/org');
  });

  it('does not render the invite shortcut for a non-team (personal) admin', () => {
    tagAc(AC_INVITE);
    // Re-render with a personal membership by swapping the session in place.
    const personal: Membership = { ...TEAM_ADMIN, kind: 'personal', slug: 'tester', memexSlug: 'personal' };
    session.memberships = [personal];
    session.currentMemexId = 'm1';
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/tester/personal/specs']}>
          <AppShell>
            <div>page</div>
          </AppShell>
        </MemoryRouter>
      </ThemeProvider>
    );
    const nav = screen.getByTestId('primary-nav');
    expect(within(nav.parentElement as HTMLElement).queryByTestId('invite-members-shortcut')).not.toBeInTheDocument();
    // restore for any later test ordering
    session.memberships = [TEAM_ADMIN];
  });
});
