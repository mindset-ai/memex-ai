import { describe, it, beforeEach, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';
import type { SessionPayload } from '../api/client';

// spec-418 t-5 — the structural guarantees of the Manage-tags surface, proven
// BEHAVIOURALLY through the real AppShell rather than by grepping source text.
//
// Two things this task promises structurally:
//   ac-8/ac-9 — /:ns/:mx/specs/tags renders the tag-admin surface with the NORMAL
//     sidebar layout, not the doc-page chrome. `/specs/tags` also matches
//     useMatch('/:ns/:mx/specs/:id') with :id='tags'; AppShell excludes the literal
//     `tags` segment (onSpecPageTenant) so the sidebar survives. Deleting that
//     four-character `!== 'tags'` guard regresses the surface — this test fails
//     when it's removed (the grep-based coverage would stay green).
//   ac-8/ac-9 — NO new nav item is added: the rendered `primary-nav` container
//     carries no Tags / Manage-tags link. Asserted against the real rendered nav
//     (the arrays rendered into the DOM), not a `to:` source regex that a template
//     literal / double-quote / variable / spread entry would slip past.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-418/acs/ac-${n}`;

// AuthContext is only consulted for the user menu / config visibility; a null
// session is the anonymous baseline the other AppShell tests rely on.
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: null, session: null as SessionPayload | null, logout: vi.fn() }),
}));

// MemexSwitcher makes API calls on mount — stub.
vi.mock('./MemexSwitcher', () => ({
  MemexSwitcher: () => <div data-testid="memex-switcher" />,
}));

// Issues nav badge count — stub to avoid a fetch on the tenant route.
vi.mock('../hooks/useMyIssuesCount', () => ({ useMyIssuesCount: () => 0 }));

import { AppShell } from './AppShell';

function renderShell(initialEntries: string[]) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spec-418 t-5: /specs/tags keeps the sidebar, not doc chrome (ac-8/ac-9)', () => {
  it('renders the sidebar (not the doc-page header) at /:ns/:mx/specs/tags', () => {
    tagAc(AC(8));
    tagAc(AC(9));
    renderShell(['/acme/main/specs/tags']);

    // The sidebar-layout container IS present…
    expect(screen.getByTestId('primary-nav')).toBeInTheDocument();
    // …and the doc-page chrome (the "← All specs" back-link) is absent. If the
    // `!== 'tags'` guard were removed, `specs/tags` would fall into the doc-page
    // layout: this assertion would then fail.
    expect(screen.queryByText('← All specs')).not.toBeInTheDocument();
    expect(screen.getByTestId('page-content')).toBeInTheDocument();
  });

  it('CONTROL: a real spec id (/:ns/:mx/specs/spec-3) DOES use the doc-page chrome', () => {
    // Proves the sidebar on /specs/tags is the guard doing its job — an ordinary
    // Spec handle at the same route shape hides the sidebar and shows doc chrome.
    tagAc(AC(9));
    renderShell(['/acme/main/specs/spec-3']);

    expect(screen.queryByTestId('primary-nav')).not.toBeInTheDocument();
    expect(screen.getByText('← All specs')).toBeInTheDocument();
  });
});

describe('spec-418 t-5: no new nav item for the tag surface (ac-8/ac-9)', () => {
  it('renders the sidebar with NO Tags / Manage-tags link', () => {
    tagAc(AC(8));
    tagAc(AC(9));
    renderShell(['/acme/main/specs']);

    const nav = screen.getByTestId('primary-nav');
    // Behavioural: the real nav arrays are rendered into `primary-nav`; assert no
    // link by accessible name matches, whatever syntax a future entry might use.
    expect(within(nav).queryByRole('link', { name: /manage tags/i })).toBeNull();
    expect(within(nav).queryByRole('link', { name: /^tags$/i })).toBeNull();

    // And no rendered nav link points at the tag-admin route by href.
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((h) => /\/specs\/tags$/.test(h))).toBe(false);
    expect(hrefs.some((h) => /\/tags$/.test(h))).toBe(false);
  });
});
