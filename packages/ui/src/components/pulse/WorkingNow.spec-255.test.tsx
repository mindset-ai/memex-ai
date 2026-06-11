import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { WorkingNow } from './WorkingNow';
import type { PresentRow } from './types';

// spec-255 ac-5 — Working Now rows are enriched with a channel glyph and a
// present-tense narrative line, and deliberately carry NO per-person intensity
// sparkline (that reads as surveillance).
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

function present(p: Partial<PresentRow> & Pick<PresentRow, 'docId'>): PresentRow {
  return {
    memexId: 'mx',
    docId: p.docId,
    actorUserId: p.actorUserId ?? 'u1',
    actorName: p.actorName ?? 'Christine',
    actorKind: p.actorKind ?? 'human',
    channel: p.channel ?? 'rest_ui',
    clientId: p.clientId ?? 'c1',
    lastSeenAt: p.lastSeenAt ?? new Date().toISOString(),
    source: p.source ?? 'heartbeat',
  };
}

describe('WorkingNow enrichment (spec-255)', () => {
  it('renders a channel glyph + present-tense line, and no per-person sparkline', () => {
    tagAc(AC(5));
    render(
      <WorkingNow
        present={[present({ docId: 'd1', channel: 'rest_ui' })]}
        specHandle={() => 'spec-229'}
        specTitle={() => 'Onboarding'}
        lastNarrative={() => 'wiring the mic prompt'}
      />,
    );

    const worker = screen.getByTestId('working-now-worker');
    // channel glyph present (rest_ui -> "web")
    expect(screen.getByTestId('worker-channel')).toHaveTextContent('web');
    // present-tense narrative line present
    expect(screen.getByTestId('worker-line')).toHaveTextContent('wiring the mic prompt');
    // NO per-person intensity sparkline: a sparkline is an svg <polyline>; there
    // must be none in the row (LiveDot is not a sparkline).
    expect(worker.querySelector('polyline')).toBeNull();
    expect(screen.queryByTestId('worker-sparkline')).toBeNull();
  });

  it('maps the agent channel glyph (mcp -> MCP)', () => {
    tagAc(AC(5));
    render(
      <WorkingNow
        present={[present({ docId: 'd2', channel: 'mcp', actorKind: 'mcp_agent', actorName: 'Claude Code' })]}
        specHandle={() => 'spec-244'}
      />,
    );
    expect(screen.getByTestId('worker-channel')).toHaveTextContent('MCP');
  });
});
