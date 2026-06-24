// spec-360 issue-6 / issue-7 — the lifecycle timeline rings the ACTIVE control.
//
// The selected phase/gate always wears a persistent SELECT_RING so you can see
// which circumstance the detail pane is showing; when the assistant has just
// navigated there (pulse=true) it brightens to PULSE_RING for the eye to follow.
// Non-active controls carry neither.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ScaffoldTimeline } from './ScaffoldTimeline';

// ac-9 (implementation): the assistant drives the spec-343 surface; the ring is
// how the surface shows WHERE it navigated.
const AC = 'mindset-prod/memex-building-itself/specs/spec-360/acs/ac-9';

// SELECT_RING/PULSE_RING differ only in the ring colour token.
const SELECT_TOKEN = 'ring-accent/60';
const PULSE_TOKEN = 'ring-accent ';

function renderTimeline(overrides: Partial<Parameters<typeof ScaffoldTimeline>[0]> = {}) {
  return render(
    <ScaffoldTimeline
      selected={'selected' in overrides ? overrides.selected! : { kind: 'phase', phase: 'build' }}
      orgBlocks={overrides.orgBlocks ?? []}
      onSelectPhase={overrides.onSelectPhase ?? vi.fn()}
      onSelectGate={overrides.onSelectGate ?? vi.fn()}
      pulse={overrides.pulse}
    />,
  );
}

describe('ScaffoldTimeline — active-control ring (issue-7, ac-9)', () => {
  it('the selected phase carries SELECT_RING when not pulsing; siblings carry neither', () => {
    tagAc(AC);
    renderTimeline({ selected: { kind: 'phase', phase: 'build' }, pulse: false });
    const build = screen.getByTestId('scaffold-timeline-phase-build');
    const specify = screen.getByTestId('scaffold-timeline-phase-specify');
    expect(build.className).toContain(SELECT_TOKEN);
    expect(build.className).not.toContain(PULSE_TOKEN);
    // A non-active phase carries no ring at all.
    expect(specify.className).not.toContain('ring-accent');
  });

  it('the selected phase brightens to PULSE_RING while pulse=true (issue-6)', () => {
    tagAc(AC);
    renderTimeline({ selected: { kind: 'phase', phase: 'build' }, pulse: true });
    const build = screen.getByTestId('scaffold-timeline-phase-build');
    expect(build.className).toContain(PULSE_TOKEN);
    // PULSE_RING is the non-/60 token; SELECT's /60 token is not applied.
    expect(build.className).not.toContain(SELECT_TOKEN);
  });

  it('rings the active GATE (not phases) when a gate is selected', () => {
    tagAc(AC);
    renderTimeline({ selected: { kind: 'gate', transition: 'build' }, pulse: true });
    const gate = screen.getByTestId('scaffold-timeline-gate-build');
    const build = screen.getByTestId('scaffold-timeline-phase-build');
    expect(gate.className).toContain(PULSE_TOKEN);
    // The phase pill is not the active control here — no ring.
    expect(build.className).not.toContain('ring-accent');
  });

  it('no selection → no control carries a ring', () => {
    tagAc(AC);
    renderTimeline({ selected: null, pulse: true });
    for (const p of ['draft', 'specify', 'build', 'verify', 'done']) {
      expect(screen.getByTestId(`scaffold-timeline-phase-${p}`).className).not.toContain(
        'ring-accent',
      );
    }
  });
});
