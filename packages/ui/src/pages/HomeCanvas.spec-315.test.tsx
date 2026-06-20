// spec-315 t-3 — the journey pearls are relocated BELOW the home-of-value on the
// graduated surface (dec-3). ac-3 (journeys still render as spec-312 pearls, not
// rebuilt) and ac-9 (layout order: home-of-value above the pearls).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
const postJourneyEventApi = vi.hoisted(() => vi.fn());
const fetchHomeApi = vi.hoisted(() => vi.fn());

vi.mock('../api/journey', () => ({ fetchJourneyStateApi, postJourneyEventApi }));
vi.mock('../api/home', () => ({ fetchHomeApi }));
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', name: 'Jo Doe', email: 'jo@example.com' },
    session: { memberships: [{ slug: 'jo', memexSlug: 'personal', kind: 'personal' }] },
    token: 'fake',
  }),
}));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => undefined }));

import { HomeCanvas } from './HomeCanvas';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-315/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  postJourneyEventApi.mockReset();
  postJourneyEventApi.mockResolvedValue(undefined);
  fetchHomeApi.mockReset();
  fetchHomeApi.mockResolvedValue({ whereYoureNeeded: [], specsInFlight: [] });
});

describe('HomeCanvas — graduated layout (spec-315)', () => {
  it('renders the journey pearls below the home-of-value once graduated (ac-3, ac-9)', async () => {
    tagAc(AC(3));
    tagAc(AC(9));
    // Every derived step attained ⇒ graduated ⇒ journey layer collapses to pearls.
    const steps = [
      { id: 'connect-agent', attained: true },
      { id: 'create-spec', attained: true },
    ];
    fetchJourneyStateApi.mockResolvedValue({
      milestones: {},
      currentStepId: 'all-set',
      preview: false,
      canPreview: false,
      steps,
    });

    render(
      <MemoryRouter initialEntries={['/home']}>
        <HomeCanvas />
      </MemoryRouter>,
    );

    // ac-3: journeys still render as the spec-312 pearls (consumed, not rebuilt).
    const pearls = await screen.findByTestId('your-journeys');
    const homeOfValue = screen.getByTestId('home-of-value');
    // graduated ⇒ the expanded journey layer is gone.
    expect(screen.queryByTestId('journey-layer')).toBeNull();
    // ac-9: the home-of-value surface precedes the pearls in the DOM.
    expect(
      homeOfValue.compareDocumentPosition(pearls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
