import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DesktopMcpStatusSync } from './DesktopMcpStatusSync';

// issue-24 #1 → t-58: the native MCP pill must be APP-GLOBAL. The status
// derivation + setMcpStatus push must run without DesktopMcpSection (the
// Settings page) being mounted at all.
const AC_GLOBAL =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-53';

vi.mock('./AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => {} }));

const listMcpTokensApi = vi.fn();
vi.mock('../api/mcp', () => ({
  listMcpTokensApi: (...a: unknown[]) => listMcpTokensApi(...a),
  // mintMcpTokenApi unused here but exported so the module shape matches.
  mintMcpTokenApi: vi.fn(),
}));

const fetchJourneyStateApi = vi.fn();
vi.mock('../api/journey', () => ({
  fetchJourneyStateApi: (...a: unknown[]) => fetchJourneyStateApi(...a),
}));

function installShell(handlers: Record<string, (args: unknown) => unknown> = {}) {
  (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {
    callHandler: (name: string, args: unknown) =>
      (handlers[name] ?? (() => ({ ok: true })))(args),
  };
}
function removeShell() {
  delete (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview;
}

const STATUS = {
  ok: true,
  targets: {
    claudeCode: { installed: true, urlMatches: true, tokenPrefix: 'mxt_active123' },
    claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear(); // pill-notification prefs persist per-device — reset between tests
  listMcpTokensApi.mockResolvedValue([
    { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt: null, revokedAt: null },
  ]);
  fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });
});
afterEach(() => removeShell());

describe('spec-304 ac-53 (issue-24 #1): the native MCP pill is app-global, not page-scoped', () => {
  it('derives status and PUSHES it to the native pill without the Settings section mounted', async () => {
    tagAc(AC_GLOBAL);
    const setMcpStatus = vi.fn(() => ({ ok: true }));
    installShell({ mcpStatus: () => STATUS, setMcpStatus });

    // Only the app-global sync is mounted — NOT DesktopMcpSection.
    render(<DesktopMcpStatusSync />);

    await waitFor(() => expect(setMcpStatus).toHaveBeenCalled());
    // Claude Code is installed + active token, no handshake → the pill reads the
    // honest "MCP ready" (transient), proving the real derivation ran here.
    const pushed = setMcpStatus.mock.calls.at(-1)?.[0] as {
      kind: string;
      label: string;
    };
    expect(pushed.label).toMatch(/^MCP/);
    expect(pushed.kind).toBe('ready');
  });

  it('pushes nothing in a plain browser (no shell to drive a pill)', async () => {
    tagAc(AC_GLOBAL);
    removeShell();
    // No bridge present → isDesktopShell() false → the hook is a no-op. Rendering
    // must not throw and must not attempt any native call.
    const { container } = render(<DesktopMcpStatusSync />);
    expect(container).toBeEmptyDOMElement();
    expect(listMcpTokensApi).not.toHaveBeenCalled();
  });
});
