// spec-360 issue-4 — the scaffold route gets a BOUNDED (min-h-0) content wrapper.
//
// The scaffold page manages its own internal scroll (a two-column surface whose
// chat panel scrolls independently). Without a bounded-height wrapper its
// `h-full` never resolves and the streaming chat grows <main>, scrolling the
// whole page. AppShell detects the scaffold tenant route and renders the
// content wrapper as `flex-1 min-h-0` there, vs plain `flex-1` on content-flow
// routes. jsdom has no real layout, so we assert on the wrapper className.

import { describe, it, beforeEach, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

import { ThemeProvider } from './ThemeContext';

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: null, session: null, logout: vi.fn() }),
}));
vi.mock('./MemexSwitcher', () => ({
  MemexSwitcher: () => <div data-testid="memex-switcher" />,
}));
vi.mock('../hooks/useMyIssuesCount', () => ({
  useMyIssuesCount: () => 0,
}));

import { AppShell } from './AppShell';

// ac-9 (implementation): the spec-343 surface is the authoritative review host;
// its bounded layout is what lets the streaming preview scroll internally.
const AC = 'mindset-prod/memex-building-itself/specs/spec-360/acs/ac-9';

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

// The wrapper is the immediate parent of the injected children.
function contentWrapper(): HTMLElement {
  return screen.getByTestId('page-content').parentElement as HTMLElement;
}

describe('AppShell — bounded content wrapper on the scaffold route (spec-360, ac-9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the scaffold tenant route a bounded (min-h-0) wrapper', () => {
    tagAc(AC);
    renderShell(['/acme/main/scaffold']);
    const wrapper = contentWrapper();
    expect(wrapper.className).toContain('min-h-0');
    expect(wrapper.className).toContain('flex-1');
  });

  it('keeps a plain flex-1 (no min-h-0) wrapper on a content-flow route (no regression)', () => {
    tagAc(AC);
    renderShell(['/specs']);
    const wrapper = contentWrapper();
    expect(wrapper.className).toContain('flex-1');
    expect(wrapper.className).not.toContain('min-h-0');
  });
});

// spec-389: the standards-list and issues surfaces now dock the same agent rail
// as scaffold, so they need the same bounded wrapper — otherwise a long streaming
// answer expands the panel and scrolls the whole page instead of staying locked.
const AC_389 = 'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-1';

describe('AppShell — bounded content wrapper on agent-rail routes (spec-389)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the standards-list tenant route a bounded (min-h-0) wrapper', () => {
    tagAc(AC_389);
    renderShell(['/acme/main/standards']);
    expect(contentWrapper().className).toContain('min-h-0');
  });

  it('gives the issues tenant route a bounded (min-h-0) wrapper', () => {
    tagAc(AC_389);
    renderShell(['/acme/main/issues']);
    expect(contentWrapper().className).toContain('min-h-0');
  });

  it('does NOT bound a single-standard doc route (no rail there)', () => {
    tagAc(AC_389);
    renderShell(['/acme/main/standards/std-1']);
    expect(contentWrapper().className).not.toContain('min-h-0');
  });
});
