// spec-305 — the reusable SDD-arc prompt card (resolve-decision, add-ac).
// ac-13 — derived milestones (resolved-decision / AC) gate these steps; they advance
//         the moment the agent does the work.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));
import { AgentPromptStep } from './AgentPromptStep';
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;
// spec-336 ac-4: steps 2–4 each present the copyable MCP prompt that drives that stage.
const AC336 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-336/acs/ac-${n}`;
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: {} });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AgentPromptStep', () => {
  it('renders the resolve-decision prompt card with the v2 decisions prompt', () => {
    tagAc(AC(13));
    tagAc(AC336(4));
    render(<AgentPromptStep stepId="resolve-decision" preview />);
    expect(screen.getByTestId('journey-step-resolve-decision')).toBeInTheDocument();
    // spec-336: the v2 copy points the agent at the spec + repo to raise decisions.
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/Using the Memex MCP/);
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/raising the key decisions/);
  });
  it('renders the add-ac prompt card with the v2 acceptance-criteria prompt', () => {
    tagAc(AC336(4));
    render(<AgentPromptStep stepId="add-ac" preview />);
    expect(screen.getByTestId('journey-step-add-ac')).toBeInTheDocument();
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/raising acceptance criteria for each decision/);
    // spec-372 issue-14 — the closing line refers to acceptance criteria, not decisions.
    tagAc(AC372(42));
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/the acceptance criteria \(ac-N\) you added/);
  });
  it('spec-372 issue-13/14: injects the provided spec token into the prompt', () => {
    tagAc(AC372(41));
    render(<AgentPromptStep stepId="resolve-decision" preview specToken="spec-376" />);
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/Look at spec-376, look at the repo/);
  });
  it('spec-372 issue-13/14: falls back to the placeholder when no token is provided', () => {
    render(<AgentPromptStep stepId="resolve-decision" preview />);
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/Look at <insert a spec number of one of your specs>,/);
  });
  it('advances when the step milestone becomes met while the step is open', async () => {
    tagAc(AC(13));
    vi.useFakeTimers();
    fetchJourneyStateApi
      .mockResolvedValueOnce({ milestones: {} }) // on arrival: not yet resolved
      .mockResolvedValue({ milestones: { hasResolvedDecision: true } }); // a later poll: resolved
    const onComplete = vi.fn();
    render(<AgentPromptStep stepId="resolve-decision" onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — not met, no advance
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000); // next poll sees the transition → schedule advance
    await vi.advanceTimersByTimeAsync(1400);
    expect(onComplete).toHaveBeenCalled();
  });

  it('does NOT advance when the milestone is already met on arrival (revisiting a completed step)', async () => {
    // spec-336 dec-6: viewing a finished step shows it as done but never bumps you forward.
    tagAc(AC(13));
    tagAc(AC372(46)); // spec-372 issue-17 — done shows the "✓ Decisions raised" badge
    vi.useFakeTimers();
    fetchJourneyStateApi.mockResolvedValue({ milestones: { hasResolvedDecision: true } });
    const onComplete = vi.fn();
    render(<AgentPromptStep stepId="resolve-decision" onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — already met: show done, suppress advance
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(2000); // well past any advance window
    expect(onComplete).not.toHaveBeenCalled();
    const badge = screen.getByTestId('agent-prompt-done');
    expect(badge.textContent).toContain('Decisions raised');
    expect(badge.textContent).toContain('✓');
    expect(badge.className).toContain('rounded-full');
  });

  it('spec-372 issue-17: the add-ac done state shows a "✓ Acceptance criteria raised" badge', async () => {
    tagAc(AC372(46));
    vi.useFakeTimers();
    fetchJourneyStateApi.mockResolvedValue({ milestones: { hasAc: true } });
    render(<AgentPromptStep stepId="add-ac" />);
    await vi.advanceTimersByTimeAsync(0); // first read — already met → done
    await vi.advanceTimersByTimeAsync(4000);
    const badge = screen.getByTestId('agent-prompt-done');
    expect(badge.textContent).toContain('Acceptance criteria raised');
    expect(badge.textContent).toContain('✓');
    expect(badge.className).toContain('rounded-full');
  });
});
