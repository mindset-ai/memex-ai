// spec-305 / spec-336 — step 1 "Connect to the Memex MCP".
// spec-421: Stage 2 (create the spec) moved to CreateFirstSpecStep. This step now
// completes on mcpConnected (was hasSpec). The tests below cover the MCP-connect flow only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));

import { CreateSpecStep } from './CreateSpecStep';
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;
const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });
});
afterEach(() => {
  vi.useRealTimers();
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
