import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useMemo, type ReactNode } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { SessionPayload } from '../api/client';
import { ThemeProvider } from './ThemeContext';
import { SearchProvider } from './SearchContext';
import { useHeaderSlot } from './HeaderSlot';
import { AppShell } from './AppShell';

// spec-192 t-3: the doc-page header search trigger. The sidebar is hidden on doc
// pages, so this is the only discovery cue there (dec-2). ac-10: clicking it
// opens the palette. ac-11: it coexists with the page's Edit/Share/⋯ actions.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-192/acs/ac-${n}`;
const DIALOG = { name: 'Search this memex' } as const;

const mockSession: SessionPayload = {
  user: {
    id: 'u-1',
    email: 'alice@example.com',
    name: 'Alice',
    status: 'active',
    emailVerified: true,
  },
  memberships: [
    {
      memexId: 'mx-alice',
      slug: 'alice',
      memexSlug: 'personal',
      name: 'Personal Memex',
      kind: 'personal' as const,
      role: 'administrator' as const,
    },
  ],
  currentMemexId: 'mx-alice',
  currentRole: 'administrator' as const,
  needsOnboarding: false,
  hiddenFeatures: [],
};

vi.mock('./AuthContext', async () => {
  const real = await vi.importActual<typeof import('./AuthContext')>('./AuthContext');
  return {
    ...real,
    useAuth: () => ({
      session: mockSession,
      user: { name: 'Alice', email: 'alice@example.com', picture: '' },
      token: 'fake-token',
      isAuthenticated: true,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    }),
  };
});

// A doc page that injects the right-side header actions via HeaderSlot, exactly
// as DocDocument does — so we can prove the search trigger coexists with them.
function DocBody() {
  // Memoized like the real caller (DocDocument): useHeaderSlot's effect depends
  // on `content`, so a fresh element each render would loop infinitely.
  const actions = useMemo(
    () => (
      <>
        <button data-testid="hdr-edit">Edit</button>
        <button data-testid="hdr-share">Share</button>
        <button data-testid="hdr-menu">⋯</button>
      </>
    ),
    [],
  );
  useHeaderSlot(actions);
  return <div data-testid="doc-body">doc</div>;
}

function renderDocShell(children: ReactNode) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/docs/doc-1']}>
        <SearchProvider>
          <AppShell>{children}</AppShell>
        </SearchProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('spec-192 t-3: doc-page header search trigger', () => {
  it('renders on a doc page (sidebar hidden) and clicking it opens the palette (ac-10)', async () => {
    tagAc(AC(10));
    tagAc(AC(1)); // scope ac-1: persistent, visible trigger exists on doc/spec pages too
    tagAc(AC(4)); // scope ac-4: palette discoverable on doc pages via the header trigger
    renderDocShell(<DocBody />);

    // Doc pages drop the sidebar — the header trigger is the discovery cue here.
    expect(screen.queryByTestId('primary-nav')).not.toBeInTheDocument();

    const trigger = screen.getByTestId('search-palette-trigger-header');
    expect(screen.queryByRole('dialog', DIALOG)).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', DIALOG)).toBeInTheDocument();
  });

  it('coexists with the existing Edit / Share / ⋯ header controls (ac-11)', () => {
    tagAc(AC(11));
    tagAc(AC(6)); // scope ac-6: existing header controls stay fully visible alongside the trigger
    // Unit level = COMPOSITIONAL proof: the trigger and every action control
    // coexist in the DOM (the trigger didn't replace or hide them). jsdom has no
    // layout engine, so VISUAL non-overlap is proven by journey-18 e2e — clicking
    // the doc-header trigger in a real browser with the actions present.
    renderDocShell(<DocBody />);

    expect(screen.getByTestId('hdr-edit')).toBeInTheDocument();
    expect(screen.getByTestId('hdr-share')).toBeInTheDocument();
    expect(screen.getByTestId('hdr-menu')).toBeInTheDocument();
    expect(screen.getByTestId('search-palette-trigger-header')).toBeInTheDocument();
  });
});

// spec-192 t-4 (ac-7): the sidebar (non-doc layout) carries NO search trigger —
// discovery on list views lives on the Specs board (SpecList), not the shell.
function renderSidebarShell() {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/alice/personal/specs']}>
        <SearchProvider>
          <AppShell>
            <div data-testid="page-content">page</div>
          </AppShell>
        </SearchProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('spec-192 t-4: sidebar has no search trigger (ac-7)', () => {
  it('renders the sidebar but no search trigger of either variant', () => {
    tagAc(AC(7));
    renderSidebarShell();
    // Sidebar IS shown on a non-doc route...
    expect(screen.getByTestId('primary-nav')).toBeInTheDocument();
    // ...and the shell itself adds no search trigger.
    expect(screen.queryByTestId('search-palette-trigger-board')).not.toBeInTheDocument();
    expect(screen.queryByTestId('search-palette-trigger-header')).not.toBeInTheDocument();
  });
});
