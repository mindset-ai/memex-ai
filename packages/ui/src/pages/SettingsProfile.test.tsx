import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-537 t-2 — the profile page and its route wiring. Two claims in ac-8, verified
// the way each demands: the rendered scroll container by mounting the page, and the
// route registration by reading App.tsx (the same source-assertion shape
// App.spec-507.test.tsx uses to pin route wiring). Real navigation through the
// account menu is covered by the Playwright journey in t-4.
const AC_ROUTE = 'mindset-prod/memex-building-itself/specs/spec-537/acs/ac-8';
const AC_SCOPE_CLARITY = 'mindset-prod/memex-building-itself/specs/spec-537/acs/ac-5';

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    token: 'test-token',
    user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', picture: '' },
    updateSession: vi.fn(),
  }),
}));

vi.mock('../api/client', () => ({
  updateProfileApi: vi.fn(),
}));

import { SettingsProfile } from './SettingsProfile';

const appSource = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'App.tsx'), 'utf8');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <SettingsProfile />
    </MemoryRouter>
  );
}

describe('spec-537 ac-8: the profile page and its route', () => {
  it('owns its own scroll container', () => {
    tagAc(AC_ROUTE);
    renderPage();

    // AppShell's <main> is overflow-hidden, so a page that does not scroll itself
    // gets clipped. Same contract as SettingsIntegrations / Standard.
    const scroller = screen.getByTestId('profile-scroll');
    expect(scroller.className).toContain('overflow-y-auto');
    expect(scroller.className).toContain('h-full');
  });

  it('registers /settings/profile inside FlatShell, and adds no flat /profile route', () => {
    tagAc(AC_ROUTE);
    const src = appSource();

    // The route exists and is wrapped in FlatShell (same shell as its sibling
    // /settings/integrations). Whitespace-insensitive so Prettier reflowing the JSX
    // can't red this — the claim is the wiring, not the formatting.
    const routeDecl = src
      .split('\n')
      .find((l) => l.includes('path="/settings/profile"'));
    expect(routeDecl, '/settings/profile route not registered in App.tsx').toBeDefined();
    expect(routeDecl!.replace(/\s+/g, '')).toContain(
      'element={<FlatShell><SettingsProfile/></FlatShell>}',
    );

    // dec-1: a flat /profile route is FORBIDDEN. `profile` is not on std-3 cl-6's
    // reserved-slug list, so such a route would shadow any namespace holding that
    // slug and make a live tenant unroutable. This pins the rejected option.
    expect(src).not.toMatch(/path="\/profile"/);
  });

  it('names the identity it governs, so it is not mistaken for Memex or org settings', () => {
    tagAc(AC_SCOPE_CLARITY);
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: /my profile/i })).toBeInTheDocument();
    // Points elsewhere for the things it does NOT govern (scope ac-5).
    expect(screen.getByText(/memex and org settings live on their own pages/i)).toBeInTheDocument();
  });
});
