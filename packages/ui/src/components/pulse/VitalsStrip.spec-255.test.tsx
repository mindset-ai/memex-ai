import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { VitalsStrip } from './VitalsStrip';
import { tempoSeries } from './pulseDerive';
import type { ActivityRow, ActorKind, PresentRow } from './types';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

const NOW = 1_700_000_000_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let seq = 0;
function act(p: Partial<ActivityRow> & Pick<ActivityRow, 'briefId'>): ActivityRow {
  seq += 1;
  return {
    id: `a${seq}`,
    memexId: 'mx',
    briefId: p.briefId,
    actorUserId: 'u1',
    actorName: null,
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: null,
    entity: p.entity ?? 'task',
    action: p.action ?? 'updated',
    narrative: 'did a thing',
    payload: null,
    createdAt: p.createdAt ?? ago(0),
  };
}
function present(actorUserId: string, actorKind: ActorKind): PresentRow {
  return {
    memexId: 'mx',
    docId: 'd1',
    actorUserId,
    actorName: null,
    actorKind,
    channel: actorKind === 'human' ? 'rest_ui' : 'mcp',
    clientId: `c-${actorUserId}`,
    lastSeenAt: new Date(NOW).toISOString(),
    source: actorKind === 'human' ? 'heartbeat' : 'floor',
  };
}

describe('VitalsStrip (spec-255)', () => {
  it('renders a tempo sparkline and an active-now presence indicator', () => {
    tagAc(AC(3));
    render(
      <VitalsStrip
        present={[present('h1', 'human'), present('a1', 'mcp_agent')]}
        activity={[act({ briefId: 'd1', createdAt: ago(60_000) }), act({ briefId: 'd2', createdAt: ago(120_000) })]}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('tempo-sparkline')).toBeInTheDocument();
    const active = screen.getByTestId('vitals-active-now');
    expect(active).toHaveTextContent('2'); // total present
    expect(active).toHaveTextContent('1 agent');
    expect(active).toHaveTextContent('1 human');
  });

  it('tempo is ONE aggregate series across specs (not per-spec)', () => {
    tagAc(AC(11));
    const activity = [
      act({ briefId: 'd1', createdAt: ago(30_000) }),
      act({ briefId: 'd2', createdAt: ago(90_000) }),
      act({ briefId: 'd1', createdAt: ago(95_000) }),
    ];
    const series = tempoSeries(activity, NOW, 30);
    expect(series).toHaveLength(30); // a single flat array = one series
    expect(Array.isArray(series[0] as unknown)).toBe(false); // NOT number[][]
    expect(series.reduce((a, b) => a + b, 0)).toBe(3); // all specs summed in
  });
});
