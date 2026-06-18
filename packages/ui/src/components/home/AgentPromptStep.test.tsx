// spec-305 — the reusable SDD-arc prompt card (resolve-decision, add-ac).
// ac-13 — derived milestones (resolved-decision / AC) gate these steps; they advance
//         the moment the agent does the work.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));
import { AgentPromptStep } from './AgentPromptStep';
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: {} });
});

describe('AgentPromptStep', () => {
  it('renders the resolve-decision prompt card', () => {
    tagAc(AC(13));
    render(<AgentPromptStep stepId="resolve-decision" preview />);
    expect(screen.getByTestId('journey-step-resolve-decision')).toBeInTheDocument();
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/resolve_decision|create_decision/);
  });
  it('renders the add-ac prompt card', () => {
    render(<AgentPromptStep stepId="add-ac" preview />);
    expect(screen.getByTestId('journey-step-add-ac')).toBeInTheDocument();
    expect(screen.getByTestId('agent-prompt').textContent).toMatch(/create_ac/);
  });
  it('advances when the step milestone is met', async () => {
    tagAc(AC(13));
    fetchJourneyStateApi.mockResolvedValue({ milestones: { hasResolvedDecision: true } });
    const onComplete = vi.fn();
    render(<AgentPromptStep stepId="resolve-decision" onComplete={onComplete} />);
    expect(await screen.findByTestId('agent-prompt-done')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2500 });
  });
});
