import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DesktopMcpStatusSync } from '../components/DesktopMcpStatusSync';

// t-66 → issue-32 / ac-63: the handshake that flips Ready→Connected is a SILENT,
// user-less server write (mcp-tokens.bumpLastUsed), so no SSE event ever fires.
// While the pill shows "Ready", the hook must re-probe on a backoff until it
// observes the handshake (token.lastUsedAt) and pushes "Connected" — without the
// user having to visit the Integrations page.
const AC_POLL = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-63';

vi.mock('../components/AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));
// No SSE: the whole point is that the handshake does NOT emit one.
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => {} }));

const listMcpTokensApi = vi.fn();
vi.mock('../api/mcp', () => ({
  listMcpTokensApi: (...a: unknown[]) => listMcpTokensApi(...a),
  mintMcpTokenApi: vi.fn(),
}));

const STATUS = {
  ok: true,
  targets: {
    claudeCode: { installed: true, urlMatches: true, tokenPrefix: 'mxt_active123' },
    claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
  },
};

function installShell(setMcpStatus: (args: unknown) => unknown) {
  (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {
    callHandler: (name: string, args: unknown) => {
      if (name === 'mcpStatus') return STATUS;
      if (name === 'setMcpStatus') return setMcpStatus(args);
      return { ok: true };
    },
  };
}
function removeShell() {
  delete (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview;
}

const token = (lastUsedAt: string | null) => [
  { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt, revokedAt: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => {
  removeShell();
  vi.useRealTimers();
});

describe('spec-304 ac-63 (t-66, issue-32): pill auto-flips Ready→Connected via backoff re-probe', () => {
  it('re-probes while Ready and pushes Connected once the token handshakes — no Integrations visit, no SSE (ac-63)', async () => {
    tagAc(AC_POLL);
    const pushes: Array<{ kind: string }> = [];
    const setMcpStatus = vi.fn((args: unknown) => {
      pushes.push(args as { kind: string });
      return { ok: true };
    });

    // Start: token minted but never used → Ready.
    listMcpTokensApi.mockResolvedValue(token(null));
    installShell(setMcpStatus);

    vi.useFakeTimers();
    render(<DesktopMcpStatusSync />);

    // Flush the on-mount probe → Ready pushed, Connected not yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(pushes.some((p) => p.kind === 'ready')).toBe(true);
    expect(pushes.some((p) => p.kind === 'connected')).toBe(false);

    // The handshake happens server-side (lastUsedAt set). NO SSE event fires.
    listMcpTokensApi.mockResolvedValue(token('2026-06-29T19:00:00Z'));

    // Advance past the first backoff step (10s): the re-probe must run and flip.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(pushes.some((p) => p.kind === 'connected')).toBe(true);
  });
});
