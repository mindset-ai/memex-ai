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
  it('renders the primary nav links (Specs, Issues, Pulse) and Standards under Principles', () => {
    // The Decisions tab is intentionally hidden in AppShell.tsx until the
    // Decisions page is implemented (see the commented-out nav entry there).
    // Re-enable the Decisions assertion alongside that nav entry when it ships.
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    expect(within(nav).getByRole('link', { name: 'Specs' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Issues' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Pulse' })).toBeInTheDocument();
    expect(within(nav).getByText('Principles')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Standards' })).toBeInTheDocument();
  });

  // spec-158 t-4: the primary nav order is Specs → Issues → Pulse (Issues sits
  // directly under Specs; Pulse drops to the bottom of the primary group).
  it('orders the primary nav Specs → Issues → Pulse', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-1');
    renderShell(['/specs']);

    const nav = screen.getByTestId('primary-nav');
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent?.trim())
      .filter((l): l is string => l === 'Specs' || l === 'Issues' || l === 'Pulse');
    expect(labels).toEqual(['Specs', 'Issues', 'Pulse']);
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

  it('marks Specs active on the bare-domain "/" route', () => {
    renderShell(['/']);

    const nav = screen.getByTestId('primary-nav');
    const specs = within(nav).getByRole('link', { name: 'Specs' });
    expect(specs.className).toContain('font-medium');
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
});
