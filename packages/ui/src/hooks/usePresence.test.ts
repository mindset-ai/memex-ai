// spec-407 t-2/t-3 — the READ hook's request shape.
//
//   ac-9  given many refs (the Pulse "Working now" caller), usePresence issues
//         EXACTLY ONE request per poll to the bulk endpoint (`/presence`, no
//         ref) — never one-per-ref. The single-ref ambient path keeps its
//         targeted `/presence?ref=<spec>` request.
//   ac-1  one request per poll regardless of spec count, and
//   ac-2  O(1) in the number of specs — the direct guard against the per-spec
//   ac-6  fan-out performance cliff ever silently returning.
//   ac-5  the single-Spec ambient indicator path is unchanged.
//
// We mock the http layer + global fetch so the assertions are about WHAT the
// hook requests, not transport. TAGGED with tagAc → reports to the PROD memex.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { PresentRow } from '../components/pulse/types';

const tenantBaseMock = vi.fn(() => '/api/ns/mx');
vi.mock('../api/http', () => ({
  tenantBase: () => tenantBaseMock(),
}));

import { usePresence } from './usePresence';

const AC = 'mindset-prod/memex-building-itself/specs/spec-407/acs';

function row(over: Partial<PresentRow> = {}): PresentRow {
  return {
    memexId: 'm-1',
    docId: 'd-1',
    actorUserId: 'u-1',
    actorName: 'Tester',
    actorKind: 'human',
    channel: 'rest_ui',
    clientId: 'c-1',
    lastSeenAt: new Date().toISOString() as unknown as PresentRow['lastSeenAt'],
    source: 'heartbeat',
    ...over,
  };
}

function okResponse(rows: PresentRow[]): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn(() => Promise.resolve(okResponse([])));

beforeEach(() => {
  fetchMock.mockClear();
  fetchMock.mockResolvedValue(okResponse([]));
  tenantBaseMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A large ref set — proves the request count does not scale with spec count.
const MANY_REFS = Array.from({ length: 200 }, (_, i) => `spec-${i + 1}`);

describe('usePresence — request shape [spec-407 t-2]', () => {
  it('ac-9/ac-1/ac-2/ac-6: many refs → exactly ONE bulk request per poll (no per-spec fan-out)', async () => {
    tagAc(`${AC}/ac-9`);
    tagAc(`${AC}/ac-1`);
    tagAc(`${AC}/ac-2`);
    tagAc(`${AC}/ac-6`);

    renderHook(() => usePresence(MANY_REFS));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // 200 specs, ONE request — not 200.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('/api/ns/mx/presence');
    // Crucially: NO per-spec ref query param.
    expect(url).not.toContain('ref=');
  });

  it('ac-5/ac-9: a single ref → one targeted /presence?ref=<spec> request (ambient path unchanged)', async () => {
    tagAc(`${AC}/ac-5`);
    tagAc(`${AC}/ac-9`);

    const ref = 'mindset-prod/memex-building-itself/specs/spec-122';
    renderHook(() => usePresence(ref));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe(`/api/ns/mx/presence?ref=${encodeURIComponent(ref)}`);
  });

  it('ac-9: merges/de-dupes returned rows by (actorUserId, clientId, docId)', async () => {
    tagAc(`${AC}/ac-9`);

    const dup = row({ actorUserId: 'u-1', clientId: 'c-1', docId: 'd-1' });
    const other = row({ actorUserId: 'u-2', clientId: 'c-2', docId: 'd-2' });
    fetchMock.mockResolvedValue(okResponse([dup, dup, other]));

    const { result } = renderHook(() => usePresence(MANY_REFS));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows).toHaveLength(2);
  });

  it('best-effort: a failed poll keeps the last-known rows rather than flickering empty', async () => {
    tagAc(`${AC}/ac-9`);
    vi.useFakeTimers();

    const present = row({ clientId: 'still-here' });
    fetchMock.mockResolvedValueOnce(okResponse([present]));

    const { result } = renderHook(() => usePresence(MANY_REFS, { intervalMs: 1_000 }));

    // First poll resolves with one present row.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.rows).toHaveLength(1);

    // Next poll fails — last-known rows must remain.
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0].clientId).toBe('still-here');
  });
});
