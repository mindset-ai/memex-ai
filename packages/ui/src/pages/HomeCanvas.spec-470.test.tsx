// spec-470 t-1 — the /home render branch (ac-9). HomeCanvas shows the new
// build-prompt hero for a spec-less user (milestones.hasSpec=false) and today's
// onboarding tracker unchanged for a user who already has a spec. The hero is
// stubbed to a sentinel (its own surface is covered by BuildPromptHero.spec-470);
// this test asserts only the branch.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import type { JourneyStateResponse } from '../api/journey';

const AC = 'mindset-prod/memex-building-itself/specs/spec-470/acs';

function journeyState(hasSpec: boolean): JourneyStateResponse {
  return {
    milestones: {
      identityConfirmed: true,
      mcpConnected: true,
      mcpToolCalled: false,
      hasSpec,
      hasResolvedDecision: false,
      hasAc: false,
      acVerified: false,
      planGrounded: false,
    },
    roleCoords: null,
    currentStepId: hasSpec ? 'done' : 'create-spec',
    steps: [
      { id: 'create-spec', attained: hasSpec },
      { id: 'create-first-spec', attained: hasSpec },
    ],
    preview: false,
    canPreview: false,
  };
}

let currentState: JourneyStateResponse = journeyState(false);
vi.mock('../api/journey', async () => {
  const real = await vi.importActual<typeof import('../api/journey')>('../api/journey');
  return {
    ...real,
    fetchJourneyStateApi: vi.fn(() => Promise.resolve(currentState)),
    postJourneyEventApi: vi.fn(() => Promise.resolve()),
    postPersonaSelectedApi: vi.fn(() => Promise.resolve()),
  };
});
vi.mock('../api/docs', () => ({ fetchDocs: vi.fn(() => Promise.resolve([])) }));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => {} }));
vi.mock('../components/AuthContext', async () => {
  const real = await vi.importActual<typeof import('../components/AuthContext')>(
    '../components/AuthContext',
  );
  return {
    ...real,
    useAuth: () => ({
      user: { id: 'u1', name: 'Alice' },
      session: { memberships: [{ slug: 'alice', memexSlug: 'personal', kind: 'personal' }] },
    }),
  };
});
vi.mock('../components/home/BuildPromptHero', () => ({
  BuildPromptHero: ({ firstName }: { firstName: string | null }) => (
    <div data-testid="hero-stub" data-firstname={firstName ?? ''} />
  ),
}));

import { HomeCanvas } from './HomeCanvas';

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <HomeCanvas />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HomeCanvas /home branch (spec-470)', () => {
  it('ac-9: hasSpec=false renders the build-prompt hero, not the tracker', async () => {
    tagAc(`${AC}/ac-9`);
    currentState = journeyState(false);
    renderHome();

    await waitFor(() => expect(screen.getByTestId('hero-stub')).toBeInTheDocument());
    expect(screen.getByTestId('hero-stub').getAttribute('data-firstname')).toBe('Alice');
    expect(screen.queryByTestId('getting-started-title')).not.toBeInTheDocument();
  });

  it('ac-9: hasSpec=true renders the existing onboarding tracker, not the hero', async () => {
    tagAc(`${AC}/ac-9`);
    currentState = journeyState(true);
    renderHome();

    await waitFor(() =>
      expect(screen.getByTestId('getting-started-title')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('hero-stub')).not.toBeInTheDocument();
  });
});
