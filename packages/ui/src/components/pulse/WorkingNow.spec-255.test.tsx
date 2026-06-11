import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { WorkingNow } from './WorkingNow';
import type { Worker } from './pulseDerive';

// spec-255 ac-5 — Working Now rows are enriched with a channel glyph and a
// present-tense narrative line, and deliberately carry NO per-person intensity
// sparkline. Workers are freshness-graded (live = pulsing, idle = static dot).
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

function worker(p: Partial<Worker> & Pick<Worker, 'docId'>): Worker {
  return {
    key: p.key ?? `${p.actorUserId ?? 'u1'} ${p.actorKind ?? 'human'}`,
    actorUserId: p.actorUserId ?? 'u1',
    actorName: p.actorName ?? 'Christine',
    actorKind: p.actorKind ?? 'human',
    channel: p.channel ?? 'rest_ui',
    clientId: p.clientId ?? 'c1',
    docId: p.docId,
    lastSeenMs: p.lastSeenMs ?? Date.now(),
    freshness: p.freshness ?? 'live',
  };
}

describe('WorkingNow enrichment (spec-255)', () => {
  it('renders a channel glyph + present-tense line, and no per-person sparkline', () => {
    tagAc(AC(5));
    render(
      <WorkingNow
        workers={[worker({ docId: 'd1', channel: 'rest_ui' })]}
        specHandle={() => 'spec-229'}
        specTitle={() => 'Onboarding'}
        lastNarrative={() => 'wiring the mic prompt'}
      />,
    );

    const w = screen.getByTestId('working-now-worker');
    expect(screen.getByTestId('worker-channel')).toHaveTextContent('web');
    expect(screen.getByTestId('worker-line')).toHaveTextContent('wiring the mic prompt');
    // NO per-person intensity sparkline: a sparkline is an svg <polyline>.
    expect(w.querySelector('polyline')).toBeNull();
    expect(screen.queryByTestId('worker-sparkline')).toBeNull();
  });

  it('maps the agent channel glyph (mcp -> MCP)', () => {
    tagAc(AC(5));
    render(
      <WorkingNow
        workers={[worker({ docId: 'd2', channel: 'mcp', actorKind: 'mcp_agent', actorName: 'Claude Code' })]}
        specHandle={() => 'spec-244'}
      />,
    );
    expect(screen.getByTestId('worker-channel')).toHaveTextContent('MCP');
  });

  it('shows a static idle dot (not pulsing) for an idle worker', () => {
    tagAc(AC(5));
    render(<WorkingNow workers={[worker({ docId: 'd3', freshness: 'idle' })]} specHandle={() => 'spec-229'} />);
    expect(screen.getByTestId('worker-idle-dot')).toBeInTheDocument();
  });
});
