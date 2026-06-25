// spec-305 — the create-spec step (copy-paste prompt + BYO PRD / sample, dec-9).
// ac-14 — the card presents a prompt + a built-in sample, and uploads nothing.
// ac-4  — the canvas self-advances the moment the spec exists (hasSpec).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));

import { CreateSpecStep } from './CreateSpecStep';
const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { hasSpec: false } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CreateSpecStep', () => {
  it('defaults to the sample prompt and can switch to a BYO-PRD prompt', () => {
    tagAc(AC(14));
    render(<CreateSpecStep preview />);
    expect(screen.getByTestId('journey-step-create-spec')).toBeInTheDocument();
    expect(screen.getByTestId('create-spec-prompt').textContent).toMatch(/Orders Dashboard/);
    fireEvent.click(screen.getByTestId('source-prd'));
    expect(screen.getByTestId('create-spec-prompt').textContent).toMatch(/PRD/);
    // no file input — the agent reads the source locally (no Memex-side upload).
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('advances the moment the spec is created while the step is open (hasSpec transition)', async () => {
    tagAc(AC(4));
    vi.useFakeTimers();
    fetchJourneyStateApi
      .mockResolvedValueOnce({ milestones: { hasSpec: false } }) // on arrival: not yet created
      .mockResolvedValue({ milestones: { hasSpec: true } }); // a later poll: the agent created it
    const onComplete = vi.fn();
    render(<CreateSpecStep onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — not met, no advance
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000); // next poll sees the transition → schedule advance
    await vi.advanceTimersByTimeAsync(1400);
    expect(onComplete).toHaveBeenCalled();
  });

  it('does NOT advance when the spec already exists on arrival (revisiting a completed step)', async () => {
    // spec-336 dec-6: viewing a step you already finished shows it as done but must never
    // bump you forward to the next step.
    tagAc(AC(4));
    vi.useFakeTimers();
    fetchJourneyStateApi.mockResolvedValue({ milestones: { hasSpec: true } });
    const onComplete = vi.fn();
    render(<CreateSpecStep onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — already met: show done, suppress advance
    await vi.advanceTimersByTimeAsync(4000); // a later poll still met, but the arrival was consumed
    await vi.advanceTimersByTimeAsync(2000); // well past any advance window
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-spec-done')).toBeInTheDocument();
  });
});

describe('CreateSpecStep — spec-372 step-1 polish (issues 5/6/9/12)', () => {
  it('issue-5: the subtitle "Memex" has no glossary tooltip', () => {
    tagAc(AC372(33));
    render(<CreateSpecStep preview />);
    expect(screen.getByText(/Get the full magic of Memex/)).toBeInTheDocument();
    expect(screen.queryByTestId('glossary-term-spec')).toBeNull();
  });

  it('issue-6: the Connect-MCP card shows no manual OS selector', () => {
    tagAc(AC372(34));
    render(<CreateSpecStep preview />);
    // claude-code is the default tool (OS-dependent) — the OS toggle is still absent.
    expect(screen.queryByTestId('os-mac')).toBeNull();
    expect(screen.queryByText('Your machine')).toBeNull();
  });

  it('issue-9: the selected starting-point chip is white-filled with an accent border + text', () => {
    tagAc(AC372(37));
    render(<CreateSpecStep preview />);
    const selected = screen.getByTestId('source-sample'); // default selection
    expect(selected.className).toContain('bg-surface');
    expect(selected.className).toContain('border-accent');
    expect(selected.className).toContain('text-accent');
    expect(selected.className).not.toContain('bg-accent/10');
  });

  it('issue-12: the "Point at my PRD" prompt is the short version with the fill-in path placeholder', () => {
    tagAc(AC372(40));
    render(<CreateSpecStep preview />);
    fireEvent.click(screen.getByTestId('source-prd'));
    const text = screen.getByTestId('create-spec-prompt').textContent ?? '';
    expect(text).toMatch(/<your path to our PRD>/);
    expect(text).not.toMatch(/Surface the decisions/i);
    expect(text).not.toMatch(/scope acceptance criteria/i);
  });
});
