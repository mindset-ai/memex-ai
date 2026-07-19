import { describe, it, beforeEach, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// Pull a real ThemeProvider so theme-toggle wiring works; everything else is stubbed.
import { ThemeProvider } from './ThemeContext';
import type { SessionPayload } from '../api/client';

// AuthContext is only consulted by AppShell to render the user menu / pick the
// account-config visibility. A minimal stub keeps the test focused on the nav.
// `mockSession` is a mutable holder so individual tests can drive the session
// (e.g. its `hiddenFeatures`) without re-mocking the module; it defaults to
// null, matching the original always-anonymous behaviour every other test relies
// on. `vi.mock` is hoisted, so the holder is declared inside the factory and
// reset per-test in `beforeEach`.
const { mockSession } = vi.hoisted(() => ({
  mockSession: { value: null as SessionPayload | null },
}));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: null,
    session: mockSession.value,
    logout: vi.fn(),
  }),
}));

// MemexSwitcher makes API calls when mounted — stub.
vi.mock('./MemexSwitcher', () => ({
  MemexSwitcher: () => <div data-testid="memex-switcher" />,
}));

// spec-158: the Issues nav badge count (my open issues). A mutable holder so
// individual tests can drive the count without re-mocking the module.
const { mockMyIssuesCount } = vi.hoisted(() => ({ mockMyIssuesCount: { value: 0 } }));
vi.mock('../hooks/useMyIssuesCount', () => ({
  useMyIssuesCount: () => mockMyIssuesCount.value,
}));

import { AppShell } from './AppShell';

function renderShell(initialEntries: string[]) {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>
  );
}

// Local fixture for the feature-hide test below: a minimal signed-in session
// with the given hidden-feature slugs. AppShell only reads `memberships` and
// `hiddenFeatures` off the session for the nav; the rest satisfy the type.
// Kept local to this file per the task.
function sessionWith(hiddenFeatures: string[]): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'nav@example.com',
      name: 'Nav Tester',
      status: 'active',
      emailVerified: true,
    },
    memberships: [],
    currentMemexId: null,
    currentRole: null,
    needsOnboarding: false,
    hiddenFeatures,
  };
}

beforeEach(() => {
  mockSession.value = null;
  mockMyIssuesCount.value = 0;
});

describe('AppShell sidebar navigation', () => {
  it('renders the primary nav links (Specs, Issues, Pulse) and Standards under Natives', () => {
    // The Decisions tab is intentionally hidden in AppShell.tsx until the
    // Decisions page is implemented (see the commented-out nav entry there).
    // Re-enable the Decisions assertion alongside that nav entry when it ships.
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    expect(within(nav).getByRole('link', { name: 'Specs' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Issues' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Pulse' })).toBeInTheDocument();
    // spec-498: the group formerly labelled "Principles" is now "Natives".
    expect(within(nav).getByText('Natives')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Standards' })).toBeInTheDocument();
  });

  // spec-498 (revises spec-260 t-11): under the Brain lead, the sidebar is three
  // labelled groups — NATIVES (Specs, Standards, Skills) then IN-BOXES (Drift,
  // Issues, QA Reports — the badge-carrying attention surfaces) then OPERATIONS
  // (Pulse, Insights, Scaffold — the instrumentation + config surfaces).
  it('groups the nav into Natives, In-boxes, then Operations, in order', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-1');
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    expect(within(nav).getByText('Natives')).toBeInTheDocument();
    expect(within(nav).getByText('In-boxes')).toBeInTheDocument();
    expect(within(nav).getByText('Operations')).toBeInTheDocument();

    // spec-498: Brain leads the sidebar as a standalone item ABOVE the Natives
    // group, so it is NOT part of these labelled groups (asserted separately).
    const GROUPED = [
      'Specs',
      'Standards',
      'Skills',
      'Drift',
      'Issues',
      'QA Reports',
      'Pulse',
      'Insights',
      'Scaffold',
    ];
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent?.trim() ?? '')
      // Badge counts render inside the link text — strip trailing digits.
      .map((l) => l.replace(/\d+$/, '').trim())
      // The sidebar also hosts the logo + auth links; assert only the groups.
      .filter((l) => GROUPED.includes(l));
    // No features hidden in this fixture, so every group member renders.
    expect(labels).toEqual(GROUPED);
  });

  // spec-498 — the Brain is the FIRST nav item and a standalone lead ABOVE the
  // "Natives" group header (the slot the parked Home Canvas used to hold). It's the
  // memex's default landing. The flat Home Canvas nav item is PARKED (see the
  // commented-out HOME_NAV_LINK in AppShell.tsx) — restore its tests alongside it.
  it('shows Brain as a standalone lead item above the Natives header, Home parked', () => {
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    const brain = within(nav).getByRole('link', { name: 'Brain' });
    expect(brain).toHaveAttribute('href', '/brain');
    // The parked Home Canvas nav item is gone.
    expect(within(nav).queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();
    // Brain renders ABOVE the "Natives" group header (DOM order), and above Specs.
    const natives = within(nav).getByText('Natives');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(brain.compareDocumentPosition(natives) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const links = within(nav).getAllByRole('link');
    expect(links.indexOf(brain)).toBeLessThan(links.indexOf(specs));
  });

  it('marks Brain active on /brain', () => {
    renderShell(['/brain']);

    const nav = screen.getByTestId('primary-nav');
    const brain = within(nav).getByRole('link', { name: 'Brain' });
    expect(brain.className).toContain('font-medium');
  });

  it('marks Issues active on /issues', () => {
    renderShell(['/issues']);

    const nav = screen.getByTestId('primary-nav');
    const issues = within(nav).getByRole('link', { name: 'Issues' });
    expect(issues.className).toContain('font-medium');
  });

  it('marks Specs active on /specs', () => {
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(specs.className).toContain('font-medium');
    const standards = within(nav).getByRole('link', { name: 'Standards' });
    expect(standards.className).not.toContain('font-medium');
  });

  // spec-498: the bare "/" (the memex index) now renders the Brain, so Brain — not
  // Specs — owns the '/' altPath and lights up on the bare-domain route.
  it('marks Brain active on the bare-domain "/" route', () => {
    renderShell(['/']);

    const nav = screen.getByTestId('primary-nav');
    const brain = within(nav).getByRole('link', { name: 'Brain' });
    expect(brain.className).toContain('font-medium');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(specs.className).not.toContain('font-medium');
  });

  it('marks Specs active on the legacy /briefs alt-path', () => {
    renderShell(['/briefs']);

    const nav = screen.getByTestId('primary-nav');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(specs.className).toContain('font-medium');
  });

  it('marks Specs active on the legacy /missions alt-path', () => {
    renderShell(['/missions']);

    const nav = screen.getByTestId('primary-nav');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(specs.className).toContain('font-medium');
  });

  it('marks Specs active on the legacy /strategies alt-path', () => {
    renderShell(['/strategies']);

    const nav = screen.getByTestId('primary-nav');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(specs.className).toContain('font-medium');
  });

  it('marks Standards active on /standards', () => {
    renderShell(['/standards']);

    const nav = screen.getByTestId('primary-nav');
    const standards = within(nav).getByRole('link', { name: 'Standards' });
    expect(standards.className).toContain('font-medium');
  });

  it('marks Pulse active on /pulse', () => {
    renderShell(['/pulse']);

    const nav = screen.getByTestId('primary-nav');
    const pulse = within(nav).getByRole('link', { name: 'Pulse' });
    expect(pulse.className).toContain('font-medium');
  });

  // SKIPPED: Decisions tab is hidden until the page is implemented (see the
  // commented-out nav entry in AppShell.tsx). Re-enable alongside the nav entry.
  it.skip('marks Decisions active on /decisions', () => {
    renderShell(['/decisions']);

    const nav = screen.getByTestId('primary-nav');
    const decisions = within(nav).getByRole('link', { name: 'Decisions' });
    expect(decisions.className).toContain('font-medium');
  });

  it('hides the sidebar when on a /docs/:id deep link', () => {
    renderShell(['/docs/doc-1']);

    expect(screen.queryByTestId('primary-nav')).not.toBeInTheDocument();
  });

  // spec-158: decision/issue deep-links render the same Spec page and must get
  // the same doc-page chrome (top bar, no sidebar) as a plain /specs/:id visit.
  it('uses the doc-page layout (top bar, no sidebar) on an issue deep-link', () => {
    renderShell(['/acme/main/specs/spec-3/issues/issue-2']);

    expect(screen.queryByTestId('primary-nav')).not.toBeInTheDocument();
    expect(screen.getByText('← All specs')).toBeInTheDocument();
  });

  // spec-158: the Issues entry carries a count pill of MY open issues (Specs
  // assigned to me) — same scope as the page's Mine default. Hidden at zero.
  it('shows a count badge on Issues when I have open issues, hidden at zero', () => {
    mockMyIssuesCount.value = 3;
    renderShell(['/specs']);

    const badge = screen.getByTestId('issues-nav-badge');
    expect(badge).toHaveTextContent('3');

    mockMyIssuesCount.value = 0;
    renderShell(['/specs']);
    // Only the first render's badge exists; a zero count renders no new badge.
    expect(screen.getAllByTestId('issues-nav-badge')).toHaveLength(1);
  });

  it('uses the doc-page layout (top bar, no sidebar) on a decision deep-link', () => {
    renderShell(['/acme/main/specs/spec-3/decisions/dec-1']);

    expect(screen.queryByTestId('primary-nav')).not.toBeInTheDocument();
    expect(screen.getByText('← All specs')).toBeInTheDocument();
  });
});

describe('AppShell feature-hide (spec-146 t-3)', () => {
  it('hides the Scaffold nav link when its feature is in the session hiddenFeatures', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-146/acs/ac-8');
    // ac-1 (scope) — the Scaffold entry is absent from the left nav for any user:
    // the filter keys off the feature slug, not role or org, and the link returns
    // when nothing is hidden.
    tagAc('mindset-prod/memex-building-itself/specs/spec-146/acs/ac-1');

    // Hidden: session lists 'scaffold' → the Scaffold link renders for no one.
    mockSession.value = sessionWith(['scaffold']);
    const hidden = renderShell(['/specs']);
    const hiddenNav = screen.getByTestId('primary-nav');
    expect(
      within(hiddenNav).queryByRole('link', { name: 'Scaffold' }),
    ).not.toBeInTheDocument();
    // A non-feature link is untouched by the filter.
    expect(within(hiddenNav).getByRole('link', { name: 'Standards' })).toBeInTheDocument();
    hidden.unmount();

    // Visible: empty hiddenFeatures → the Scaffold link is present again.
    mockSession.value = sessionWith([]);
    renderShell(['/specs']);
    const visibleNav = screen.getByTestId('primary-nav');
    expect(within(visibleNav).getByRole('link', { name: 'Scaffold' })).toBeInTheDocument();
  });

  // PARKED with the Home Canvas nav item: the flat /home surface no longer renders a
  // nav link at all (HOME_NAV_LINK is commented out in AppShell.tsx), so its
  // feature-hide behaviour is dormant. Un-skip alongside restoring HOME_NAV_LINK.
  // The Home Canvas (spec-303) is gated by the same mechanism: 'home' in the
  // session hiddenFeatures drops the top nav link, so the whole surface can be
  // hidden per-env (prod) while it stays live on int. The route is gated to
  // match in App.tsx (redirect when hidden).
  it.skip("hides the Home nav link when 'home' is in the session hiddenFeatures", () => {
    // Hidden: 'home' listed → no Home link for anyone on this env.
    mockSession.value = sessionWith(['home']);
    const hidden = renderShell(['/specs']);
    const hiddenNav = screen.getByTestId('primary-nav');
    expect(within(hiddenNav).queryByRole('link', { name: 'Home' })).not.toBeInTheDocument();
    // Specs (a non-feature link) is untouched — only Home went away.
    expect(within(hiddenNav).getByRole('link', { name: 'Specs' })).toBeInTheDocument();
    hidden.unmount();

    // Visible: empty hiddenFeatures → Home returns as the first nav item.
    mockSession.value = sessionWith([]);
    renderShell(['/specs']);
    const visibleNav = screen.getByTestId('primary-nav');
    expect(within(visibleNav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });
});
