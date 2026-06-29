// spec-305 / spec-336 — step 1 "Connect to the Memex MCP".
// spec-421: Stage 2 (create the spec) moved to CreateFirstSpecStep. This step now
// completes on mcpConnected (was hasSpec). The tests below cover the MCP-connect flow only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));

import { CreateSpecStep } from './CreateSpecStep';
import { setCachedJourneyState, resetCachedJourneyState } from '../../journeys/journeyStateCache';
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;
const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });
  resetCachedJourneyState();
});
afterEach(() => {
  vi.useRealTimers();
});

// spec-421 issue-2 — same before-draw fix as CreateFirstSpecStep: a revisiting user who has
// already connected MCP must see the "Connected" card on first paint, not the connect card
// flipping to connected after an after-mount fetch.
describe('CreateSpecStep — assess connected before draw (spec-421 issue-2)', () => {
  it('a revisiting user (mcpConnected, cached assessment) sees the Connected card on the FIRST render (ac-21, ac-22)', () => {
    tagAc(AC421(21));
    tagAc(AC421(22));
    setCachedJourneyState({ milestones: { mcpConnected: true } } as never);

    render(<CreateSpecStep onComplete={vi.fn()} />);

    // Synchronous first render — no await: the connected done-badge (rendered only when
    // `connected` is true) is present immediately, never the not-connected→connected flip.
    expect(screen.getByTestId('create-spec-connected')).toBeInTheDocument();
    expect(screen.getByText('Connected to the Memex MCP')).toBeInTheDocument();
  });
});

describe('CreateSpecStep — spec-421: MCP connect only, completes on mcpConnected', () => {
  it('renders the MCP connect card with no Stage-2 prompt or source selectors', () => {
    tagAc(AC421(4)); // step 2 shows MCP connect card only, no "Create Your First Spec" section
    tagAc(AC421(11)); // no method selector / starting-point selector
    render(<CreateSpecStep preview />);
    expect(screen.getByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('connect-stage')).toBeInTheDocument();
    // Stage 2 elements are gone (moved to CreateFirstSpecStep).
    expect(screen.queryByTestId('create-spec-prompt')).toBeNull();
    expect(screen.queryByTestId('source-sample')).toBeNull();
    expect(screen.queryByTestId('source-prd')).toBeNull();
  });

  it('advances the moment MCP is connected while the step is open (mcpConnected transition)', async () => {
    tagAc(AC421(5)); // step 2 completes on mcpConnected
    vi.useFakeTimers();
    fetchJourneyStateApi
      .mockResolvedValueOnce({ milestones: { mcpConnected: false } }) // on arrival: not yet connected
      .mockResolvedValue({ milestones: { mcpConnected: true } }); // a later poll: MCP connected
    const onComplete = vi.fn();
    render(<CreateSpecStep onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — not met, no advance
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000); // next poll sees the transition → schedule advance
    await vi.advanceTimersByTimeAsync(1400);
    expect(onComplete).toHaveBeenCalled();
  });

  it('does NOT advance when MCP is already connected on arrival (revisiting a completed step)', async () => {
    // spec-336 dec-6: viewing a step you already finished shows it as connected but must
    // never bump you forward. spec-421: connected badge replaces the old "Created" badge.
    tagAc(AC421(5));
    vi.useFakeTimers();
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true } });
    const onComplete = vi.fn();
    render(<CreateSpecStep onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — already met: show connected, suppress advance
    await vi.advanceTimersByTimeAsync(4000); // later poll still met, arrival already consumed
    await vi.advanceTimersByTimeAsync(2000);
    expect(onComplete).not.toHaveBeenCalled();
    const badge = screen.getByTestId('create-spec-connected');
    expect(badge.textContent).toContain('Connected');
    expect(badge.textContent).toContain('✓');
    expect(badge.className).toContain('rounded-full');
  });
});

describe('CreateSpecStep — spec-372 step-1 polish (issues 5/6)', () => {
  it('issue-5: the subtitle has no glossary tooltip', () => {
    tagAc(AC372(33));
    render(<CreateSpecStep preview />);
    expect(screen.getByText(/Get the full magic of Memex/)).toBeInTheDocument();
    expect(screen.queryByTestId('glossary-term-spec')).toBeNull();
  });

  it('issue-6: the Connect-MCP card shows no manual OS selector', () => {
    tagAc(AC372(34));
    render(<CreateSpecStep preview />);
    expect(screen.queryByTestId('os-mac')).toBeNull();
    expect(screen.queryByText('Your machine')).toBeNull();
  });
});

// spec-372 issue-19 — the Connect-MCP card's connected (done) state. This is the slice of
// issue-19 that survived spec-421's onboarding-v4 split intact (the create-spec-card ACs
// ac-49/50/51/54/55/56 moved to / were redesigned in CreateFirstSpecStep, so they are not
// covered here). Reach the connected state via the polled milestone, as the advance tests
// above do.
describe('CreateSpecStep — spec-372 issue-19 connected-card state', () => {
  // Reach the connected state deterministically with fake timers (mirrors the
  // "does NOT advance … on arrival" test above) — the first poll's init branch sets
  // connected=true. Wall-clock findBy* is flaky under CI's coverage-instrumented load.
  const renderConnected = async () => {
    vi.useFakeTimers();
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true } });
    render(<CreateSpecStep />);
    await vi.advanceTimersByTimeAsync(0); // first read — init branch sets connected
    await vi.advanceTimersByTimeAsync(4000); // a later poll — settle the re-render
  };

  it('ac-52: the connected MCP card shows the "Connected to the Memex MCP" heading + manage-from-Integrations description', async () => {
    tagAc(AC372(52));
    await renderConnected();
    expect(screen.getByText('Connected to the Memex MCP')).toBeInTheDocument();
    expect(
      screen.getByText(/You're connected to the Memex MCP\. Need to make changes\? Manage it any time from the Integrations page under your profile menu\./),
    ).toBeInTheDocument();
  });

  it('ac-53: the connected MCP card uses the muted completed style (plain border, no glow ring) with a CSS transition', async () => {
    tagAc(AC372(53));
    await renderConnected();
    const stage = screen.getByTestId('connect-stage');
    expect(stage.className).toContain('border-edge'); // plain edge border
    expect(stage.className).not.toContain('ring-accent'); // glow ring gone
    expect(stage.className).toContain('transition-all'); // animated change
  });
});
