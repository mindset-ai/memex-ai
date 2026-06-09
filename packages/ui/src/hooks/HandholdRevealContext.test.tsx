// spec-206 t-2 (ac-8): the reveal pointer is lifted to a SHARED, commandable
// surface. One provider drives every consumer (the board + the voice-layer
// bridge), so an orchestrator-issued advance walks the demo phase everyone reads.
// Without a provider, the consumer falls back to a standalone pointer (preserving
// the many existing SpecList/DocDocument tests that render without it).

import { describe, it, expect, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { render, screen, act } from '@testing-library/react';
import { HandholdRevealProvider, useHandholdRevealValue } from './HandholdRevealContext';

const AC8 = 'mindset-prod/memex-building-itself/specs/spec-206/acs/ac-8';

// A board-ish consumer that shows the revealed phase.
function PhaseReadout({ label }: { label: string }) {
  const { revealedPhase } = useHandholdRevealValue('acme', 'team');
  return <span data-testid={label}>{revealedPhase}</span>;
}

// Stands in for the voice-layer bridge: holds the advance fn the orchestrator calls.
let orchestratorAdvance: () => void = () => {};
function OrchestratorBridge() {
  const { advance } = useHandholdRevealValue('acme', 'team');
  orchestratorAdvance = advance;
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  orchestratorAdvance = () => {};
});

describe('HandholdRevealProvider — shared, commandable reveal pointer (spec-206 ac-8)', () => {
  it('an orchestrator-issued advance walks the phase for every board consumer', () => {
    render(
      <HandholdRevealProvider namespace="acme" memex="team">
        <PhaseReadout label="board-a" />
        <PhaseReadout label="board-b" />
        <OrchestratorBridge />
      </HandholdRevealProvider>,
    );

    // Both consumers start at the default first phase.
    expect(screen.getByTestId('board-a').textContent).toBe('draft');
    expect(screen.getByTestId('board-b').textContent).toBe('draft');

    // The "orchestrator" advances — both shared consumers move together.
    act(() => orchestratorAdvance());
    expect(screen.getByTestId('board-a').textContent).toBe('specify');
    expect(screen.getByTestId('board-b').textContent).toBe('specify');

    act(() => orchestratorAdvance());
    expect(screen.getByTestId('board-a').textContent).toBe('build');
    expect(screen.getByTestId('board-b').textContent).toBe('build');

    tagAc(AC8);
  });

  it('falls back to a standalone pointer when no provider is mounted', () => {
    // No provider — the consumer still works (default phase), proving the
    // back-compat path the existing page tests rely on.
    render(<PhaseReadout label="solo" />);
    expect(screen.getByTestId('solo').textContent).toBe('draft');
  });
});
