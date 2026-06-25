import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { activeNow } from './pulseDerive';
import type { PresentRow } from './types';

// spec-255 — Pulse enhancement. Unit coverage for the Vitals "active now"
// derivation, which counts who is PRESENT right now (from the presence plane,
// spec-122) split human vs agent. Sourced from PresentRow[] (presence), NOT
// activity_log.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

/** Build a PresentRow fixture; sensible defaults, override what the test needs. */
function present(
  p: Partial<PresentRow> & Pick<PresentRow, 'actorUserId' | 'actorKind'>,
): PresentRow {
  return {
    memexId: 'mx',
    docId: p.docId ?? 'doc-1',
    actorUserId: p.actorUserId,
    actorName: p.actorName ?? null,
    actorKind: p.actorKind,
    channel: p.channel ?? (p.actorKind === 'human' ? 'rest_ui' : 'mcp'),
    clientId: p.clientId ?? 'c1',
    lastSeenAt: p.lastSeenAt ?? new Date().toISOString(),
    source: p.source ?? (p.actorKind === 'human' ? 'heartbeat' : 'floor'),
  };
}

describe('activeNow (spec-255)', () => {
  it('splits humans vs agents and totals them; one worker counts once', () => {
    tagAc(AC(9));
    const rows: PresentRow[] = [
      present({ actorUserId: 'u1', actorKind: 'human', clientId: 'b1' }),
      present({ actorUserId: 'u2', actorKind: 'human', clientId: 'b2' }),
      present({ actorUserId: 'u3', actorKind: 'mcp_agent', clientId: 's1' }),
      // same worker present on a SECOND spec — must not double-count.
      present({ actorUserId: 'u3', actorKind: 'mcp_agent', clientId: 's1', docId: 'doc-2' }),
    ];
    expect(activeNow(rows)).toEqual({ humans: 2, agents: 1, total: 3 });
  });

  it('is sourced from presence rows (heartbeat + floor); excludes system', () => {
    tagAc(AC(10));
    const rows: PresentRow[] = [
      present({ actorUserId: 'u1', actorKind: 'human', source: 'heartbeat' }),
      present({ actorUserId: 'a1', actorKind: 'mcp_agent', source: 'floor', clientId: 's1' }),
      present({ actorUserId: 'a2', actorKind: 'in_app_agent', source: 'heartbeat', clientId: 'iaa' }),
      present({ actorUserId: 'sys', actorKind: 'system', clientId: 'srv' }),
    ];
    // human=1, agents=mcp_agent+in_app_agent=2, system excluded.
    expect(activeNow(rows)).toEqual({ humans: 1, agents: 2, total: 3 });
  });

  it('is empty-safe', () => {
    tagAc(AC(9));
    expect(activeNow([])).toEqual({ humans: 0, agents: 0, total: 0 });
  });
});
