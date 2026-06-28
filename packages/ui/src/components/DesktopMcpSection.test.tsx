import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DesktopMcpSection } from './DesktopMcpSection';

const AC_UMBRELLA = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-45';
const AC_INSTALL = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-4';
const AC_REACH = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-50';
// t-56: Claude Desktop is connector-based — single "Install for my org" button
// opening the instructions dialog (no npx install), and connected-via-signal.
const AC_CONNECTOR_DIALOG =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-55';
const AC_CONNECTOR_STATUS =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-56';

// ── Mocks ────────────────────────────────────────────────────────────────
vi.mock('./AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => {} }));

const listMcpTokensApi = vi.fn();
const mintMcpTokenApi = vi.fn();
vi.mock('../api/mcp', () => ({
  listMcpTokensApi: (...a: unknown[]) => listMcpTokensApi(...a),
  mintMcpTokenApi: (...a: unknown[]) => mintMcpTokenApi(...a),
}));

const fetchJourneyStateApi = vi.fn();
vi.mock('../api/journey', () => ({
  fetchJourneyStateApi: (...a: unknown[]) => fetchJourneyStateApi(...a),
}));

// The Flutter bridge: present = desktop shell. We drive callHandler per name.
function installShell(
  handlers: Record<string, (args: unknown) => unknown> = {},
) {
  (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {
    callHandler: (name: string, args: unknown) =>
      (handlers[name] ?? (() => ({ ok: true })))(args),
  };
}
function removeShell() {
  delete (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview;
}

const STATUS_ABSENT = {
  ok: true,
  targets: {
    claudeCode: { installed: false, urlMatches: false, tokenPrefix: null },
    claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  listMcpTokensApi.mockResolvedValue([]);
  mintMcpTokenApi.mockResolvedValue({ token: 'mxt_minted_secret_999', prefix: 'mxt_minted9' });
  fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });
});
afterEach(() => removeShell());

describe('spec-304 ac-45 / ac-50: the in-app MCP surface in Settings → Integrations', () => {
  it('renders nothing in a plain browser (no shell = cannot write config)', () => {
    tagAc(AC_REACH);
    removeShell();
    const { container } = render(<DesktopMcpSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('inside the shell it always shows the canonical install surface with both clients (ac-50)', async () => {
    tagAc(AC_REACH);
    tagAc(AC_UMBRELLA);
    installShell({ mcpStatus: () => STATUS_ABSENT });
    render(<DesktopMcpSection />);

    expect(
      await screen.findByRole('heading', { name: 'Install Memex MCP on this device' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('mcp-client-claudeCode')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-client-claudeDesktop')).toBeInTheDocument();
  });

  it('Claude Code connected reads from the per-token handshake (lastUsedAt), not the user signal', async () => {
    tagAc(AC_UMBRELLA);
    installShell({
      mcpStatus: () => ({
        ok: true,
        targets: {
          claudeCode: { installed: true, urlMatches: true, tokenPrefix: 'mxt_active123' },
          claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
        },
      }),
    });
    listMcpTokensApi.mockResolvedValue([
      { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt: '2026-06-28T10:00:00Z', revokedAt: null },
    ]);
    // user-scoped signal is false — CC connected must come from the token only.
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });

    render(<DesktopMcpSection />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-status-claudeCode')).toHaveTextContent('MCP connected'),
    );
  });
});

describe('spec-304 ac-4: Claude Code install from the app mints + writes via the bridge', () => {
  it('clicking Install runs mint→installMcp and shows a restart prompt (token never shown)', async () => {
    tagAc(AC_INSTALL);
    tagAc(AC_UMBRELLA);
    const installMcp = vi.fn(() => ({ ok: true, name: 'Claude Code', path: '/p', backupPath: '/p.bak' }));
    const showNotification = vi.fn(() => ({ ok: true }));
    const setMcpStatus = vi.fn(() => undefined);
    installShell({
      mcpStatus: () => STATUS_ABSENT,
      installMcp,
      showNotification,
      setMcpStatus,
    });

    render(<DesktopMcpSection />);
    const row = await screen.findByTestId('mcp-client-claudeCode');
    fireEvent.click(within(row).getByRole('button', { name: 'Install' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Restart Claude Code/),
    );
    // Minted a token from the session and handed it to the bridge — never to the DOM.
    expect(mintMcpTokenApi).toHaveBeenCalledWith('Memex Desktop', 'test-token');
    expect(installMcp).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'mxt_minted_secret_999', target: 'claudeCode' }),
    );
    expect(document.body.innerHTML).not.toContain('mxt_minted_secret_999');
    // Success was announced natively (dec-22).
    expect(showNotification).toHaveBeenCalled();
  });
});

describe('spec-304 ac-55 / ac-56 (t-56): Claude Desktop is connector-based, not npx', () => {
  it('Claude Desktop shows a single "Install for my org" button that opens the connector dialog — no installMcp', async () => {
    tagAc(AC_CONNECTOR_DIALOG);
    const installMcp = vi.fn(() => ({ ok: true }));
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp });

    render(<DesktopMcpSection />);
    const cdRow = await screen.findByTestId('mcp-client-claudeDesktop');
    // The npx-era Install/Reinstall/Repair button is gone for Claude Desktop.
    const button = within(cdRow).getByRole('button', { name: 'Install for my org' });
    fireEvent.click(button);

    // The connector-instructions dialog opens…
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('connector-url')).toHaveTextContent('/mcp');
    // …and NO npx/file-write install was attempted for Claude Desktop.
    expect(installMcp).not.toHaveBeenCalled();
    expect(mintMcpTokenApi).not.toHaveBeenCalled();
  });

  it('Claude Desktop reads "MCP connected" from the mcp.connected signal with no local entry (ac-56)', async () => {
    tagAc(AC_CONNECTOR_STATUS);
    installShell({ mcpStatus: () => STATUS_ABSENT }); // no local CD entry at all
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true } });

    render(<DesktopMcpSection />);

    await waitFor(() =>
      expect(screen.getByTestId('mcp-status-claudeDesktop')).toHaveTextContent('MCP connected'),
    );
  });
});
