import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { HotSpecs } from './HotSpecs';
import type { ActivityRow, ActorKind, PresentRow } from './types';
import type { AcHealth } from '../../api/types';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

const NOW = 1_700_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let seq = 0;
function act(briefId: string, agoMs: number): ActivityRow {
  seq += 1;
  return {
    id: `a${seq}`,
    memexId: 'mx',
    briefId,
    actorUserId: 'u1',
    actorName: null,
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: null,
    entity: 'task',
    action: 'updated',
    narrative: 'did a thing',
    payload: null,
    createdAt: ago(agoMs),
  };
}
function present(docId: string, actorKind: ActorKind = 'mcp_agent'): PresentRow {
  return {
    memexId: 'mx',
    docId,
    actorUserId: `u-${docId}`,
    actorName: 'Claude Code',
    actorKind,
    channel: actorKind === 'human' ? 'rest_ui' : 'mcp',
    clientId: `c-${docId}`,
    lastSeenAt: new Date(NOW).toISOString(),
    source: actorKind === 'human' ? 'heartbeat' : 'floor',
  };
}
const HEALTH: AcHealth = { totalActive: 10, covered: 9, verified: 8, failing: 1, stale: 0, untested: 1 };

const handles: Record<string, string> = { 'doc-A': 'spec-244', 'doc-B': 'spec-229' };
const phases: Record<string, string> = { 'doc-A': 'build', 'doc-B': 'verify' };
const narratives: Record<string, string> = { 'doc-A': 'AC-7 went green', 'doc-B': 'wiring the mic prompt' };
const href = (h: string) => `/mindset-prod/memex-building-itself/specs/${h}`;

function renderHot(specPhase?: (docId: string) => string | undefined) {
  return render(
    <MemoryRouter>
      <HotSpecs
        present={[present('doc-A', 'mcp_agent')]}
        activity={[
          act('doc-A', 10_000),
          act('doc-B', 30_000),
          act('doc-B', 35_000),
        ]}
        now={NOW}
        specHandle={(d) => handles[d]}
        specTitle={(d) => `Title ${d}`}
        specPhase={specPhase ?? ((d) => phases[d])}
        specNarrative={(d) => narratives[d]}
        specAcHealth={() => HEALTH}
        specHref={href}
      />
    </MemoryRouter>,
  );
}

describe('HotSpecs band (spec-255)', () => {
  it('ranks live work and each card shows phase, who, AC progress, narrative', () => {
    tagAc(AC(4));
    renderHot();
    const cards = screen.getAllByTestId('hot-spec-card');
    expect(cards).toHaveLength(2);
    // doc-A is present → ranks first.
    expect(cards[0]).toHaveAttribute('data-doc-id', 'doc-A');

    const first = within(cards[0]);
    expect(first.getByTestId('phase-chip')).toHaveTextContent('build');
    expect(first.getByTestId('hot-spec-line')).toHaveTextContent('AC-7 went green');
    expect(first.getByTestId('hot-spec-avatars')).toBeInTheDocument();
    // live AC progress bar (reused SpecHealthStrip) — green + rose present.
    expect(first.getByTestId('spec-health-strip')).toBeInTheDocument();
    expect(first.getByTestId('spec-health-strip-verified')).toBeInTheDocument();
    expect(first.getByTestId('spec-health-strip-failing')).toBeInTheDocument();
  });

  it('clicking a card navigates to that spec via its path-based route', () => {
    tagAc(AC(14));
    renderHot();
    const cards = screen.getAllByTestId('hot-spec-card');
    expect(cards[0]).toHaveAttribute('href', '/mindset-prod/memex-building-itself/specs/spec-244');
    expect(cards[0].tagName).toBe('A');
  });

  it('pops the phase chip when a spec changes phase', () => {
    tagAc(AC(18));
    const { rerender } = renderHot((d) => (d === 'doc-A' ? 'build' : phases[d]));
    // no pop on first render
    expect(
      within(screen.getAllByTestId('hot-spec-card')[0]).getByTestId('phase-chip'),
    ).not.toHaveAttribute('data-popping');

    // advance doc-A build → verify
    rerender(
      <MemoryRouter>
        <HotSpecs
          present={[present('doc-A', 'mcp_agent')]}
          activity={[act('doc-A', 10_000), act('doc-B', 30_000), act('doc-B', 35_000)]}
          now={NOW}
          specHandle={(d) => handles[d]}
          specTitle={(d) => `Title ${d}`}
          specPhase={(d) => (d === 'doc-A' ? 'verify' : phases[d])}
          specNarrative={(d) => narratives[d]}
          specAcHealth={() => HEALTH}
          specHref={href}
        />
      </MemoryRouter>,
    );
    const cardA = screen
      .getAllByTestId('hot-spec-card')
      .find((c) => c.getAttribute('data-doc-id') === 'doc-A')!;
    expect(within(cardA).getByTestId('phase-chip')).toHaveAttribute('data-popping', 'true');
    expect(within(cardA).getByTestId('phase-chip')).toHaveTextContent('verify');
  });
});
