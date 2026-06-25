// spec-372 t-6 (dec-3) — the graduated-home surfaces are reversibly removed from Home:
//   "Where you're needed" + "Your specs" (HomeValue, spec-315) and the "Your Journeys"
//   pearls (YourJourneys, spec-312) no longer render. The components and the spec-312/315
//   graduation/journeys state logic are kept intact (verified by their own suites, which
//   mock SHOW_GRADUATED_HOME on); this suite verifies the SHIPPED default — flag OFF — so
//   none of the three surfaces appear on Home.
//
//   ac-8  (scope) — the three sections no longer render on Home (logic preserved).
//   ac-14 (impl)  — HomeCanvas renders none of their testids while components/logic remain.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
// NB: deliberately NOT mocking ./homeCanvasFlags — this suite exercises the real shipped
// default (SHOW_GRADUATED_HOME === false).

import { HomeCanvas } from './HomeCanvas';
import { ONBOARDING_MILESTONE_STEP_IDS } from '../journeys/onboarding/steps';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

type Step = { id: string; attained: boolean };

function stateFor(currentStepId: string, steps: Step[]) {
  return {
    milestones: {
      identityConfirmed: false,
      mcpConnected: false,
      hasSpec: false,
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

const NOT_GRADUATED: Step[] = [
  { id: 'create-spec', attained: true },
  { id: 'resolve-decision', attained: false },
];
const GRADUATED: Step[] = [
  { id: 'create-spec', attained: true },
  { id: 'resolve-decision', attained: true },
];

const REMOVED_TESTIDS = ['home-of-value', 'home-where-needed', 'home-specs', 'your-journeys'];

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

describe('spec-372 t-6: graduated-home surfaces removed from Home (dec-3)', () => {
  it('ac-8 / ac-14: none of the three surfaces render while onboarding (journey layer still shows)', async () => {
    tagAc(AC(8));
    tagAc(AC(14));
    fetchJourneyStateApi.mockResolvedValue(stateFor('resolve-decision', NOT_GRADUATED));
    renderCanvas();
    // The active onboarding still renders.
    expect(await screen.findByTestId('journey-layer')).toBeInTheDocument();
    // None of the removed graduated-home surfaces appear.
    for (const id of REMOVED_TESTIDS) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });

  it('ac-8 / ac-14: none of the three surfaces render once graduated either', async () => {
    tagAc(AC(8));
    tagAc(AC(14));
    fetchJourneyStateApi.mockResolvedValue(stateFor('all-set', GRADUATED));
    renderCanvas();
    // The page itself still mounts (title present).
    expect(await screen.findByTestId('home-page-title')).toBeInTheDocument();
    for (const id of REMOVED_TESTIDS) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });
});

describe('spec-372 t-2: Home layout (ac-5)', () => {
  it('ac-5: the rail↔content column gutter is widened (md:gap-16, the v3 64px)', async () => {
    tagAc(AC(5));
    fetchJourneyStateApi.mockResolvedValue(stateFor('resolve-decision', NOT_GRADUATED));
    renderCanvas();
    const content = await screen.findByTestId('journey-content');
    const twoCol = content.parentElement as HTMLElement;
    expect(twoCol.className).toContain('md:gap-16');
  });
});

describe('spec-372 t-10: funnel-spine step_shown (ac-21)', () => {
  it('ac-21: the active step emits home_canvas.step_shown, and all six steps are milestone steps', async () => {
    tagAc(AC(21));
    fetchJourneyStateApi.mockResolvedValue(stateFor('resolve-decision', NOT_GRADUATED));
    renderCanvas();
    await waitFor(() => expect(postJourneyEventApi).toHaveBeenCalledWith('resolve-decision', 'shown'));
    // The funnel spine covers all six v3 steps (each fires step_shown when active).
    expect([...ONBOARDING_MILESTONE_STEP_IDS]).toEqual([
      'identity',
      'create-spec',
      'resolve-decision',
      'add-ac',
      'specs-match-reality',
      'agents-build',
    ]);
  });
});

describe('spec-372 t-11: cross-session re-entry (ac-27)', () => {
  it('ac-27: a remembered cursor on an already-completed step does NOT strand the returning user', async () => {
    tagAc(AC(27));
    // The user last viewed 'identity', but the server has advanced them to 'create-spec'
    // (identity attained). The spec-336 no-strand rule (preserved under spec-372) must follow
    // the live step, not pin them to the done one.
    window.localStorage.setItem('memex:onboarding:viewing:u-1', 'identity');
    fetchJourneyStateApi.mockResolvedValue(
      stateFor('create-spec', [
        { id: 'identity', attained: true },
        { id: 'create-spec', attained: false },
      ]),
    );
    renderCanvas();
    expect(await screen.findByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.queryByTestId('journey-step-identity')).not.toBeInTheDocument();
  });
});
