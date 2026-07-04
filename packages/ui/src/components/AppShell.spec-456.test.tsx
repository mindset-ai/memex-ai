import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';

// spec-456 — account menu grouped into sections + icons + danger sign-out +
// What's New micro-interaction. One AC per observable outcome.
const AC_GROUPS = 'mindset-prod/memex-building-itself/specs/spec-456/acs/ac-1';
const AC_ICONS = 'mindset-prod/memex-building-itself/specs/spec-456/acs/ac-2';
const AC_SIGNOUT = 'mindset-prod/memex-building-itself/specs/spec-456/acs/ac-3';
const AC_PRESERVED = 'mindset-prod/memex-building-itself/specs/spec-456/acs/ac-4';
const AC_HOOKS = 'mindset-prod/memex-building-itself/specs/spec-456/acs/ac-5';
const AC_MICRO = 'mindset-prod/memex-building-itself/specs/spec-456/acs/ac-6';

// Hoisted spies so the test can assert the callbacks the menu items are wired to.
const { logoutSpy, openWhatsNewSpy } = vi.hoisted(() => ({
  logoutSpy: vi.fn(),
  openWhatsNewSpy: vi.fn(),
}));

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
  user: { name: 'Tester', email: 't@acme.test' },
  memberships: [TEAM_ADMIN],
  currentMemexId: 'm1',
};

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { name: 'Tester', email: 't@acme.test' },
    session,
    logout: logoutSpy,
  }),
}));

// What's New is hidden by default (WhatsNewContext defaults to available:false);
// surface it so the notification row + its micro-interaction are exercised.
vi.mock('./whats-new/WhatsNewContext', () => ({
  useWhatsNew: () => ({
    available: true,
    openPopup: openWhatsNewSpy,
    registerMenuAnchor: vi.fn(),
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
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/acme/team/specs']}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>
  );
}

// Click the user card to (re-)open the dropdown. Safe to call more than once in
// a test — the shell stays mounted, so there's only ever one "Tester" to click.
function openUserMenu() {
  fireEvent.click(screen.getByText('Tester'));
}

function openMenu() {
  renderShell();
  openUserMenu();
}

/** The popup element that holds the menu rows. */
function menuRoot(): HTMLElement {
  return screen.getByTestId('user-menu-whats-new').parentElement as HTMLElement;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('spec-456: account menu grouping + icons + micro-interaction', () => {
  it('ac-1: groups the 7 items into four sections with three dividers, none re-routed', () => {
    tagAc(AC_GROUPS);
    openMenu();
    const menu = menuRoot();

    // Three dividers → four groups.
    expect(within(menu).getAllByRole('separator')).toHaveLength(3);

    // Every item still present (team-admin on localhost → all gates open).
    expect(screen.getByTestId('user-menu-whats-new')).toBeInTheDocument();
    for (const label of [
      'Memex settings',
      'Memex keys',
      'Org configuration',
      'Integrations',
      'Email preview',
      'Watch intro video',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    // Order preserved: What's New first, Sign out last.
    const rows = Array.from(menu.querySelectorAll('a, button')).map((el) =>
      el.textContent?.trim()
    );
    expect(rows[0]).toBe("What's New");
    expect(rows[rows.length - 1]).toBe('Sign out');
    const idx = (t: string) => rows.indexOf(t);
    expect(idx('Memex settings')).toBeLessThan(idx('Integrations'));
    expect(idx('Integrations')).toBeLessThan(idx('Watch intro video'));

    // Destinations unchanged (nothing re-routed).
    expect(screen.getByRole('link', { name: 'Memex settings' })).toHaveAttribute(
      'href',
      '/acme/team/settings'
    );
    expect(screen.getByRole('link', { name: 'Org configuration' })).toHaveAttribute(
      'href',
      '/acme/team/org'
    );
    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'href',
      '/settings/integrations'
    );
    expect(screen.getByRole('link', { name: 'Watch intro video' })).toHaveAttribute(
      'href',
      '/welcome?rewatch=1'
    );
  });

  it('ac-2: every row shows a leading svg icon, and What’s New drops the emoji', () => {
    tagAc(AC_ICONS);
    openMenu();
    const menu = menuRoot();

    for (const row of Array.from(menu.querySelectorAll('a, button'))) {
      expect(row.querySelector('svg')).not.toBeNull();
    }
    // The 🎁 emoji is gone — replaced by the gift svg.
    const whatsNew = screen.getByTestId('user-menu-whats-new');
    expect(whatsNew.textContent).not.toContain('🎁');
    expect(whatsNew.querySelector('svg')).not.toBeNull();
  });

  it('ac-3: Sign out sits after its own divider and reddens on hover', () => {
    tagAc(AC_SIGNOUT);
    openMenu();

    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(signOut.className).toContain('hover:text-status-danger-text');
    // Its immediately-preceding sibling is a divider.
    expect(signOut.previousElementSibling).toHaveAttribute('role', 'separator');
  });

  it('ac-4: visibility gates and click behaviours are preserved', () => {
    tagAc(AC_PRESERVED);
    openMenu();

    // Gate-open items render for a team admin.
    expect(screen.getByRole('link', { name: 'Memex settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Memex keys' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Org configuration' })).toBeInTheDocument();

    // Sign out still calls logout.
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logoutSpy).toHaveBeenCalledTimes(1);

    // Clicking a link closes the menu (setOpen(false) preserved).
    openUserMenu();
    fireEvent.click(screen.getByRole('link', { name: 'Integrations' }));
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('ac-5: existing testids and role selectors still resolve', () => {
    tagAc(AC_HOOKS);
    openMenu();

    // The testids other code/tests rely on are unchanged.
    expect(screen.getByTestId('user-menu-whats-new')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-email-preview')).toBeInTheDocument();

    // The exact queries spec-141 uses against this menu still pass.
    expect(screen.getByRole('link', { name: 'Memex settings' })).toHaveAttribute(
      'href',
      '/acme/team/settings'
    );
    expect(screen.getByRole('link', { name: 'Integrations' })).toHaveAttribute(
      'href',
      '/settings/integrations'
    );
  });

  it('ac-6: What’s New carries the unwrap+confetti structure and stays safe under reduced motion', () => {
    tagAc(AC_MICRO);
    openMenu();

    const whatsNew = screen.getByTestId('user-menu-whats-new');
    // Hover unwrap: the row is a group and the gift has a lid + sparkle to animate.
    expect(whatsNew.className).toContain('group');
    expect(whatsNew.querySelector('.wn-lid')).not.toBeNull();
    expect(whatsNew.querySelector('.wn-sparkle')).not.toBeNull();
    // Click confetti: a canvas is present to draw into.
    expect(
      screen.getByTestId('user-menu-whats-new-confetti').tagName.toLowerCase()
    ).toBe('canvas');

    // Clicking still opens the popup (confetti is a no-op in jsdom, never throws).
    fireEvent.click(whatsNew);
    expect(openWhatsNewSpy).toHaveBeenCalledTimes(1);

    // Under prefers-reduced-motion the click path is still safe and functional.
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    try {
      openUserMenu();
      fireEvent.click(screen.getByTestId('user-menu-whats-new'));
      expect(openWhatsNewSpy).toHaveBeenCalledTimes(2);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
