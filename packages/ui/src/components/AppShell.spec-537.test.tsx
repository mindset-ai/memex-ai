import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';

// spec-537 t-1 (ac-7) — the "My profile" row in the account menu. The assertion that
// matters is ADJACENCY to Sign out, not mere presence: "no other menu item between
// them" is the part of the claim a presence check would silently let rot.
const AC_MENU_ROW = 'mindset-prod/memex-building-itself/specs/spec-537/acs/ac-7';

const TEAM_ADMIN = {
  memexId: 'm1',
  slug: 'acme',
  memexSlug: 'team',
  name: 'Acme Inc',
  memexName: 'Team',
  kind: 'team' as const,
  role: 'administrator' as const,
};

const session = {
  user: { id: 'u1', name: 'Tester', email: 't@acme.test' },
  memberships: [TEAM_ADMIN],
  currentMemexId: 'm1',
};

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Tester', email: 't@acme.test' },
    session,
    logout: vi.fn(),
  }),
}));

vi.mock('./whats-new/WhatsNewContext', () => ({
  useWhatsNew: () => ({
    available: true,
    hasUnseen: false,
    openPopup: vi.fn(),
    registerMenuAnchor: vi.fn(),
  }),
}));

vi.mock('./MemexSwitcher', () => ({ MemexSwitcher: () => <div data-testid="memex-switcher" /> }));
vi.mock('./InviteMembersDialog', () => ({ InviteMembersDialog: () => <div data-testid="invite-dialog" /> }));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ isAuthenticated: true, isVisitedReadOnly: false }),
}));
vi.mock('../hooks/useDriftInboxCount', () => ({ useDriftInboxCount: () => 0 }));
vi.mock('../journeys/journeyStateCache', () => ({
  getCachedJourneyState: () => ({ milestones: { mcpConnected: true } }),
}));
vi.mock('../api/journey', () => ({
  fetchJourneyStateApi: () => Promise.resolve({ milestones: { mcpConnected: true } }),
}));
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: vi.fn(), optedOut: false, setOptOut: vi.fn() }),
}));

import { AppShell } from './AppShell';

function openMenu() {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/acme/team/specs']}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByText('Tester'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('spec-537 ac-7: "My profile" in the account menu', () => {
  it('links to /settings/profile and carries an icon, per the spec-456 menu convention', () => {
    tagAc(AC_MENU_ROW);
    openMenu();

    const profile = screen.getByTestId('user-menu-profile');
    expect(profile).toHaveTextContent('My profile');
    expect(profile).toHaveAttribute('href', '/settings/profile');
    expect(profile.querySelector('svg')).not.toBeNull();
  });

  it('sits immediately above Sign out, with no menu item between them', () => {
    tagAc(AC_MENU_ROW);
    openMenu();

    const profile = screen.getByTestId('user-menu-profile');
    const signOut = screen.getByText('Sign out').closest('button');
    expect(signOut).not.toBeNull();

    // The claim is adjacency: no menu ITEM between them. The one element that IS
    // allowed between is the separator that keeps Sign out in its own destructive
    // group — spec-456 ac-3 requires Sign out's previous sibling to be that
    // separator, so asserting the exact chain here pins both contracts at once and
    // catches a future row inserted into the gap.
    const divider = profile.nextElementSibling;
    expect(divider).toHaveAttribute('role', 'separator');
    expect(divider!.nextElementSibling).toBe(signOut);
  });

  it('does not reuse the invite icon, whose glyph reads "add someone"', () => {
    tagAc(AC_MENU_ROW);
    openMenu();

    const profileIcon = screen.getByTestId('user-menu-profile').querySelector('svg');
    const invitePath = 'M18 7.5v3m0 0v3m0-3h3m-3 0h-3';
    expect(profileIcon?.innerHTML ?? '').not.toContain(invitePath);
  });
});
