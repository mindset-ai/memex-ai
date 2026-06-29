import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DesktopMcpStatusSync } from '../components/DesktopMcpStatusSync';

// t-61 → issue-27 / ac-58: the native pill re-revealed on (nearly) every
// navigation because a background re-derive re-pushed the SAME indicator. React
// must de-dupe — only push when the derived indicator actually changed — so a
// redundant re-derive does not make the pill pop back open.
const AC_NO_REREVEAL =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-58';

vi.mock('../components/AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));

// Capture the user-change-stream callback so the test can fire a re-derive
// exactly like a background SSE event would (the source of the spurious pushes).
let changeCb: (() => void) | null = null;
vi.mock('../hooks/useUserChangeStream', () => ({
  useUserChangeStream: (cb: () => void) => {
    changeCb = cb;
  },
}));

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

function installShell(handlers: Record<string, (args: unknown) => unknown>) {
  (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {
    callHandler: (name: string, args: unknown) =>
      (handlers[name] ?? (() => ({ ok: true })))(args),
  };
}
function removeShell() {
  delete (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  changeCb = null;
  listMcpTokensApi.mockResolvedValue([
    { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt: null, revokedAt: null },
  ]);
});
afterEach(() => removeShell());

describe('spec-304 ac-58 (t-61, issue-27): the pill is not re-pushed on a redundant re-derive', () => {
  it('pushes the indicator once and does NOT re-push when an SSE re-derive yields the same status (ac-58)', async () => {
    tagAc(AC_NO_REREVEAL);
    const setMcpStatus = vi.fn(() => ({ ok: true }));
    installShell({ mcpStatus: () => STATUS, setMcpStatus });

    render(<DesktopMcpStatusSync />);

    // First derive → one push of the honest "MCP ready" state.
    await waitFor(() => expect(setMcpStatus).toHaveBeenCalledTimes(1));

    // A background user-change event fires a re-derive. The local config and
    // tokens are unchanged, so the derived indicator is identical — it must NOT
    // be pushed again (issue-27: a redundant push made the pill re-reveal).
    await act(async () => {
      changeCb?.();
    });
    // Give the async refresh time to complete and (wrongly) re-push if it would.
    await new Promise((r) => setTimeout(r, 20));

    expect(setMcpStatus).toHaveBeenCalledTimes(1);
  });
});
