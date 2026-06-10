// spec-122 ac-5 — ambient presence on the spec/AC surface.
//
// Presence is visible BOTH in Pulse AND as an ambient indicator where the work
// happens. This suite exercises the two halves a spec/AC view wires together:
//   1. mounting the view fires the heartbeat POST (a human viewing marks present);
//   2. the ambient indicator renders the presence GET's rows (a live dot + who).
//
// We drive the REAL hooks (usePresenceHeartbeat + usePresence) against a mocked
// fetch + tenant base — the same substrate DocDocument mounts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { usePresenceHeartbeat } from '../../hooks/usePresenceHeartbeat';
import { usePresence } from '../../hooks/usePresence';
import { SpecPresenceIndicator } from './SpecPresenceIndicator';
import type { PresentRow } from './types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-122/acs/ac-${n}`;

// Both hooks resolve the tenant base from the URL path → mock it to a tenant.
vi.mock('../../api/http', async () => {
  const actual = await vi.importActual<typeof import('../../api/http')>('../../api/http');
  return {
    ...actual,
    tenantBase: () => '/api/acme/main',
    // usePresenceHeartbeat POSTs through fetchWithRetry — route it to global fetch.
    fetchWithRetry: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  };
});

const PRESENT: PresentRow = {
  memexId: 'mx-1',
  docId: 'sb-12',
  actorUserId: 'u-9',
  actorName: 'Claude Code (Barrie)',
  actorKind: 'mcp_agent',
  channel: 'mcp',
  clientId: 'sess-1',
  lastSeenAt: new Date().toISOString(),
  source: 'heartbeat',
};

// A spec/AC-style view that mounts both halves exactly as DocDocument does.
function SpecView({ specRef }: { specRef: string }) {
  usePresenceHeartbeat(specRef);
  const { rows } = usePresence(specRef);
  return rows.length > 0 ? (
    <SpecPresenceIndicator present={rows} variant="ac" />
  ) : (
    <div data-testid="no-presence" />
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/presence') && method === 'POST') {
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    if (url.includes('/presence') && method === 'GET') {
      return Promise.resolve(
        new Response(JSON.stringify([PRESENT]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response('[]', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  window.localStorage.setItem('memex-auth-token', 'tok');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('ambient spec/AC presence (spec-122 ac-5)', () => {
  it('fires the heartbeat POST when the view mounts', async () => {
    tagAc(AC(5));
    render(<SpecView specRef="spec-12" />);

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([url, init]) => {
        const u = typeof url === 'string' ? url : String(url);
        return u.includes('/presence') && (init?.method ?? 'GET').toUpperCase() === 'POST';
      });
      expect(postCalls.length).toBeGreaterThan(0);
      // The body carries the spec ref ONLY — no document content.
      const body = JSON.parse((postCalls[0][1] as RequestInit).body as string);
      expect(body).toEqual({ ref: 'spec-12' });
    });
  });

  it('renders the ambient indicator (live dot + who) from the presence GET', async () => {
    tagAc(AC(5));
    render(<SpecView specRef="spec-12" />);

    const indicator = await screen.findByTestId('spec-presence-indicator');
    expect(indicator).toHaveTextContent('Claude Code (Barrie)');
    // The AC-variant caveat surfaces that ACs may shift while an agent works.
    expect(indicator).toHaveTextContent(/ACs may shift/);
    // A breathing live dot is part of the indicator.
    expect(indicator.querySelector('span[role="img"], span')).toBeTruthy();
  });
});
