// spec-421 — step 2 "Create your first spec".
//   ac-6  — step 3 renders the "Create your first spec" H2, blue CTA, sample prompt helper.
//   ac-7  — blue CTA navigates to the Specs page with ?new=1 (onCreateInApp).
//   ac-8  — sample prompt helper is collapsible (truncated by default, expand/collapse).
//   ac-9  — copying the sample prompt fires the copy_create_prompt CTA (via journey-cta.spec-324).
//   ac-10 — step 3 completes on hasSpec (not mcpConnected).
//   ac-11 — no method selector / starting-point selector.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));

import { CreateFirstSpecStep } from './CreateFirstSpecStep';
import { setCachedJourneyState, resetCachedJourneyState } from '../../journeys/journeyStateCache';

const AC421 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-421/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { hasSpec: false } });
  resetCachedJourneyState();
});
afterEach(() => {
  vi.useRealTimers();
});

// spec-421 issue-2 — the in-Home flicker was the content panel, not the rail: `done` started
// false and flipped true after an after-mount journey-state fetch ("Create" → "Created").
// With the shared assessment warm, a revisiting user must see the DONE state on first paint.
describe('CreateFirstSpecStep — assess done before draw (spec-421 issue-2)', () => {
  it('a revisiting user (hasSpec, cached assessment) sees "Created" on the FIRST render — no Create→Created flip (ac-21, ac-22)', () => {
    tagAc(AC421(21));
    tagAc(AC421(22));
    setCachedJourneyState({ milestones: { hasSpec: true } } as never);

    render(<CreateFirstSpecStep onComplete={vi.fn()} />);

    // Synchronous first render — no await: already the done state, never the "Create" card.
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/Created your first spec/);
    expect(screen.getByTestId('create-first-spec-done')).toBeInTheDocument();
    expect(screen.queryByTestId('create-first-spec-btn')).toBeNull();
    expect(screen.queryByTestId('create-first-spec-status')).toBeNull();
  });

  it('with no cached assessment the first paint is unchanged (not-done) — cold path preserved (ac-23)', () => {
    tagAc(AC421(23));
    render(<CreateFirstSpecStep onComplete={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/^Create your first spec/);
    expect(screen.queryByTestId('create-first-spec-done')).toBeNull();
  });
});

describe('CreateFirstSpecStep — spec-421 step 3', () => {
  it('ac-6: renders the "Create your first spec" H2, blue CTA, and sample prompt helper', () => {
    tagAc(AC421(6));
    render(<CreateFirstSpecStep preview />);
    expect(screen.getByTestId('journey-step-create-first-spec')).toBeInTheDocument();
    const h2 = screen.getByRole('heading', { level: 2 });
    expect(h2.textContent).toMatch(/Create your first spec/);
    expect(screen.getByTestId('create-first-spec-btn')).toBeInTheDocument();
    expect(screen.getByTestId('sample-prompt-helper')).toBeInTheDocument();
  });

  it('ac-7: the blue CTA fires onCreateInApp (navigates to Specs page with ?new=1)', () => {
    tagAc(AC421(7));
    const onCreateInApp = vi.fn();
    render(<CreateFirstSpecStep preview onCreateInApp={onCreateInApp} />);
    fireEvent.click(screen.getByTestId('create-first-spec-btn'));
    expect(onCreateInApp).toHaveBeenCalledTimes(1);
  });

  it('ac-8: the sample prompt helper is collapsed by default and expands/collapses', () => {
    tagAc(AC421(8));
    render(<CreateFirstSpecStep preview />);
    const container = screen.getByTestId('sample-prompt-container');
    // Collapsed by default — the container has a max-height cap.
    expect(container.className).toContain('max-h-[13rem]');
    // Expand button visible; collapse button hidden.
    expect(screen.getByTestId('sample-prompt-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('sample-prompt-collapse')).toBeNull();
    // Click expand.
    fireEvent.click(screen.getByTestId('sample-prompt-expand'));
    // Now expanded — no max-h cap; expand button gone; collapse visible.
    expect(screen.getByTestId('sample-prompt-container').className).not.toContain('max-h-[13rem]');
    expect(screen.queryByTestId('sample-prompt-expand')).toBeNull();
    expect(screen.getByTestId('sample-prompt-collapse')).toBeInTheDocument();
    // Click collapse.
    fireEvent.click(screen.getByTestId('sample-prompt-collapse'));
    expect(screen.getByTestId('sample-prompt-container').className).toContain('max-h-[13rem]');
  });

  it('ac-10: advances the moment hasSpec transitions to true (spec completes on hasSpec)', async () => {
    tagAc(AC421(10));
    vi.useFakeTimers();
    fetchJourneyStateApi
      .mockResolvedValueOnce({ milestones: { hasSpec: false } })
      .mockResolvedValue({ milestones: { hasSpec: true } });
    const onComplete = vi.fn();
    render(<CreateFirstSpecStep onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — not yet, no advance
    expect(onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000); // next poll sees the transition
    await vi.advanceTimersByTimeAsync(1400);
    expect(onComplete).toHaveBeenCalled();
  });

  it('ac-10: does NOT advance when hasSpec is already true on arrival (revisiting a done step)', async () => {
    tagAc(AC421(10));
    vi.useFakeTimers();
    fetchJourneyStateApi.mockResolvedValue({ milestones: { hasSpec: true } });
    const onComplete = vi.fn();
    render(<CreateFirstSpecStep onComplete={onComplete} />);
    await vi.advanceTimersByTimeAsync(0); // first read — already met: show done, no advance
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onComplete).not.toHaveBeenCalled();
    const badge = screen.getByTestId('create-first-spec-done');
    expect(badge.textContent).toContain('Created');
    expect(badge.textContent).toContain('✓');
    expect(badge.className).toContain('rounded-full');
  });

  it('ac-26: the content-area subtitle is the create-spec copy, not the MCP-step subtitle (issue-3)', () => {
    // issue-3 — the content panel duplicated the "Connect to the Memex MCP" subtitle.
    // The create-spec step must show its own subtitle and NOT the MCP one.
    tagAc(AC421(26));
    const { container } = render(<CreateFirstSpecStep preview />);
    expect(container.textContent).toContain(
      'Draft your first spec with your coding agent, or create it here in the app.',
    );
    expect(container.textContent).not.toContain('Get the full magic of Memex by connecting to the MCP');
  });

  it('ac-11: no method selector or starting-point selector', () => {
    tagAc(AC421(11));
    render(<CreateFirstSpecStep preview />);
    // No method (agent/in-app) or source (sample/prd) chips.
    expect(screen.queryByTestId('source-sample')).toBeNull();
    expect(screen.queryByTestId('source-prd')).toBeNull();
    expect(screen.queryByTestId('method-agent')).toBeNull();
    expect(screen.queryByTestId('method-app')).toBeNull();
  });
});
