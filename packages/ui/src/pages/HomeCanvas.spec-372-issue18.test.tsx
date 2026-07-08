// spec-372 issue-18 (dec-9) — Home reduces the left/right whitespace by 25%.
//   Both Home content containers — the page header and the journey-layer wrapper — cap
//   their width with `max-w-[calc(25%_+_48rem)]` (CSS `max-width: calc(25% + 48rem)`)
//   instead of `max-w-5xl`, so each side gutter is 75% of its former value at every pane
//   width. This mirrors the spec-308 max-width className assertion pattern.
//
//   ac-47 (impl) — both containers carry the calc cap and no longer carry max-w-5xl.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
const postJourneyEventApi = vi.hoisted(() => vi.fn());
const postPersonaSelectedApi = vi.hoisted(() => vi.fn());
const fetchHomeApi = vi.hoisted(() => vi.fn());

vi.mock('../api/journey', () => ({ fetchJourneyStateApi, postJourneyEventApi, postPersonaSelectedApi }));
vi.mock('../api/home', () => ({ fetchHomeApi }));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'John Doe', email: 'john@example.com' },
    session: { memberships: [{ slug: 'john', memexSlug: 'personal', kind: 'personal' }] },
    token: 'fake',
  }),
}));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => undefined }));

import { HomeCanvas } from './HomeCanvas';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;
const CAP = 'max-w-[calc(25%_+_48rem)]';

type Step = { id: string; attained: boolean };

function stateFor(currentStepId: string, steps: Step[]) {
  return {
    milestones: {
      identityConfirmed: false,
      mcpConnected: false,
      hasSpec: true,
      hasResolvedDecision: false,
      hasAc: false,
      planGrounded: false,
    },
    currentStepId,
    steps,
    preview: false,
    canPreview: false,
  };
}

// spec-421: resolve-decision is hidden; must include create-first-spec (not attained) so
// the journey layer remains visible (otherwise all visible steps are attained → graduated).
const NOT_GRADUATED: Step[] = [
  { id: 'identity', attained: true },
  { id: 'create-spec', attained: true },
  { id: 'create-first-spec', attained: false },
  { id: 'resolve-decision', attained: false },
];

function renderCanvas() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <HomeCanvas />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  postJourneyEventApi.mockReset();
  postJourneyEventApi.mockResolvedValue(undefined);
  postPersonaSelectedApi.mockReset();
  fetchHomeApi.mockReset();
  fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specs: [] });
  window.localStorage.clear();
});

describe('spec-372 issue-18 (dec-9): Home side whitespace reduced 25% (ac-47)', () => {
  it('ac-47: the page header container caps at calc(25% + 48rem), not max-w-5xl', async () => {
    tagAc(AC(47));
    fetchJourneyStateApi.mockResolvedValue(stateFor('resolve-decision', NOT_GRADUATED));
    renderCanvas();
    const title = await screen.findByTestId('home-page-title');
    const headerContainer = title.parentElement as HTMLElement;
    expect(headerContainer.className).toContain(CAP);
    expect(headerContainer.className).not.toContain('max-w-5xl');
  });

  it('ac-47: the journey-layer container caps at calc(25% + 48rem), not max-w-5xl', async () => {
    tagAc(AC(47));
    fetchJourneyStateApi.mockResolvedValue(stateFor('resolve-decision', NOT_GRADUATED));
    renderCanvas();
    const layer = await screen.findByTestId('journey-layer');
    const layerContainer = layer.firstElementChild as HTMLElement;
    expect(layerContainer.className).toContain(CAP);
    expect(layerContainer.className).not.toContain('max-w-5xl');
  });
});
