import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DesktopMcpSection } from './DesktopMcpSection';

const AC_UMBRELLA = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-45';
const AC_INSTALL = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-4';
const AC_REACH = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-50';
// dec-24: connector is a neutral setup row (never "connected"); per-client pill
// notification toggle.
const AC_CONNECTOR = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-56';
const AC_DIALOG = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-55';
const AC_TOGGLE = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-57';
// dec-25 → t-70: a failed in-app Claude Code install surfaces a useful error in
// the Integrations surface — a plain-language cause (mint vs config-write vs
// unknown), a Retry, and a "Copy details" diagnostic (path + error + app/OS).
const AC_FAIL_SURFACE = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-68';
// t-71 → ac-70: copy must state Claude Code covers the terminal, IDE extensions
// AND the Code tab inside Claude Desktop (one shared ~/.claude.json); the
// connector covers Chat + Cowork (not the Code tab). std-1 clean.
const AC_COPY = 'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-70';

vi.mock('./AuthContext', () => ({ useAuth: () => ({ token: 'test-token' }) }));
vi.mock('../hooks/useUserChangeStream', () => ({ useUserChangeStream: () => {} }));

const listMcpTokensApi = vi.fn();
const mintMcpTokenApi = vi.fn();
vi.mock('../api/mcp', () => ({
  listMcpTokensApi: (...a: unknown[]) => listMcpTokensApi(...a),
  mintMcpTokenApi: (...a: unknown[]) => mintMcpTokenApi(...a),
}));

// Record every setMcpStatus push (both real states and the {kind:'none'} hide).
let mcpPushes: Array<{ kind?: string }> = [];
function installShell(handlers: Record<string, (args: unknown) => unknown> = {}) {
  (window as unknown as { flutter_inappwebview?: unknown }).flutter_inappwebview = {
    callHandler: (name: string, args: unknown) => {
      if (name === 'setMcpStatus') mcpPushes.push(args as { kind?: string });
      return (handlers[name] ?? (() => ({ ok: true })))(args);
    },
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
// Claude Code installed + active token, no handshake → "MCP ready" (drives pill).
const STATUS_CC_READY = {
  ok: true,
  targets: {
    claudeCode: { installed: true, urlMatches: true, tokenPrefix: 'mxt_active123' },
    claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mcpPushes = [];
  localStorage.clear(); // pill-notification prefs persist per-device — reset between tests
  listMcpTokensApi.mockResolvedValue([]);
  mintMcpTokenApi.mockResolvedValue({ token: 'mxt_minted_secret_999', prefix: 'mxt_minted9' });
});
afterEach(() => removeShell());

describe('spec-304 ac-45 / ac-50: the in-app MCP surface', () => {
  it('renders nothing in a plain browser (no shell = cannot write config)', () => {
    tagAc(AC_REACH);
    removeShell();
    const { container } = render(<DesktopMcpSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('inside the shell it shows both client rows (ac-50)', async () => {
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

  it('Claude Code connected reads from the per-token handshake (lastUsedAt)', async () => {
    tagAc(AC_UMBRELLA);
    installShell({ mcpStatus: () => STATUS_CC_READY });
    listMcpTokensApi.mockResolvedValue([
      { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt: '2026-06-28T10:00:00Z', revokedAt: null },
    ]);
    render(<DesktopMcpSection />);
    await waitFor(() =>
      expect(screen.getByTestId('mcp-status-claudeCode')).toHaveTextContent('MCP connected'),
    );
  });
});

describe('spec-304 ac-4: Claude Code install mints + writes via the bridge', () => {
  it('clicking Install runs mint→installMcp and shows a restart prompt (token never shown)', async () => {
    tagAc(AC_INSTALL);
    tagAc(AC_UMBRELLA);
    const installMcp = vi.fn(() => ({ ok: true, name: 'Claude Code', path: '/p', backupPath: '/p.bak' }));
    const showNotification = vi.fn(() => ({ ok: true }));
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp, showNotification });

    render(<DesktopMcpSection />);
    const row = await screen.findByTestId('mcp-client-claudeCode');
    fireEvent.click(within(row).getByRole('button', { name: 'Install' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Restart Claude Code/),
    );
    expect(mintMcpTokenApi).toHaveBeenCalledWith('Memex Desktop', 'test-token');
    expect(installMcp).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'mxt_minted_secret_999', target: 'claudeCode' }),
    );
    expect(document.body.innerHTML).not.toContain('mxt_minted_secret_999');
    expect(showNotification).toHaveBeenCalled();
  });
});

describe('spec-304 ac-55 / ac-56 (dec-24): Claude Desktop is a connector setup row, never "connected"', () => {
  it('the Org Connector row shows a neutral "Set up in Claude" status — never "MCP connected"', async () => {
    tagAc(AC_CONNECTOR);
    installShell({ mcpStatus: () => STATUS_ABSENT });
    render(<DesktopMcpSection />);

    const cdRow = await screen.findByTestId('mcp-client-claudeDesktop');
    await waitFor(() =>
      expect(screen.getByTestId('mcp-status-claudeDesktop')).toHaveTextContent('Set up in Claude'),
    );
    expect(cdRow).not.toHaveTextContent(/MCP connected/i);
    // It's labelled as the Org Connector and carries no notification toggle.
    expect(cdRow).toHaveTextContent('Org Connector');
    expect(within(cdRow).queryByRole('checkbox')).toBeNull();
  });

  it('"Install for my org" opens the connector dialog — no installMcp / mint', async () => {
    tagAc(AC_DIALOG);
    const installMcp = vi.fn(() => ({ ok: true }));
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp });

    render(<DesktopMcpSection />);
    const cdRow = await screen.findByTestId('mcp-client-claudeDesktop');
    fireEvent.click(within(cdRow).getByRole('button', { name: 'Install for my org' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('connector-url')).toHaveTextContent('/mcp');
    expect(installMcp).not.toHaveBeenCalled();
    expect(mintMcpTokenApi).not.toHaveBeenCalled();
  });
});

describe('spec-304 ac-70 (t-71): copy names where each transport lands — Code tab vs Chat + Cowork', () => {
  it('the Claude Code side names the terminal, IDE extensions, AND the Code tab (one shared ~/.claude.json)', async () => {
    tagAc(AC_COPY);
    installShell({ mcpStatus: () => STATUS_ABSENT });
    const { container } = render(<DesktopMcpSection />);
    await screen.findByRole('heading', { name: 'Install Memex MCP on this device' });

    const text = container.textContent ?? '';
    // Claude Code coverage is spelled out: terminal + IDE + the Code tab.
    expect(text).toMatch(/terminal/i);
    expect(text).toMatch(/IDE/i);
    expect(text).toMatch(/Code tab/i);
    expect(text).toMatch(/\.claude\.json/);
  });

  it('the connector side names Claude Desktop\'s Chat AND Cowork (not the Code tab)', async () => {
    tagAc(AC_COPY);
    installShell({ mcpStatus: () => STATUS_ABSENT });
    const { container } = render(<DesktopMcpSection />);
    await screen.findByRole('heading', { name: 'Install Memex MCP on this device' });

    const text = container.textContent ?? '';
    expect(text).toMatch(/Chat/);
    expect(text).toMatch(/Cowork/);
  });

  it('std-1 clean: no user-visible "account" or "team" anywhere in the section', async () => {
    tagAc(AC_COPY);
    installShell({ mcpStatus: () => STATUS_ABSENT });
    const { container } = render(<DesktopMcpSection />);
    await screen.findByRole('heading', { name: 'Install Memex MCP on this device' });

    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\baccount\b/i);
    expect(text).not.toMatch(/\bteam\b/i);
  });
});

describe('spec-304 ac-68 (dec-25): a failed Claude Code install surfaces a useful error + Retry + Copy details', () => {
  async function clickInstall() {
    const row = await screen.findByTestId('mcp-client-claudeCode');
    fireEvent.click(within(row).getByRole('button', { name: 'Install' }));
  }

  it('a TOKEN-MINT failure shows an auth-flavoured cause, a Retry, and a copyable diagnostic', async () => {
    tagAc(AC_FAIL_SURFACE);
    mintMcpTokenApi.mockRejectedValue(new Error('session expired'));
    const installMcp = vi.fn(() => ({ ok: true }));
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp });

    render(<DesktopMcpSection />);
    await clickInstall();

    const surface = await screen.findByTestId('mcp-install-error');
    // Plain-language cause that distinguishes the MINT failure mode (auth/session),
    // not the config-write one.
    expect(surface).toHaveTextContent(/sign|session|log|authoriz|token from your/i);
    // The mint never reached the bridge.
    expect(installMcp).not.toHaveBeenCalled();
    // Retry + Copy details controls are present.
    expect(within(surface).getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(within(surface).getByRole('button', { name: /copy details/i })).toBeInTheDocument();
  });

  it('a CONFIG-WRITE failure shows a config-flavoured cause distinct from the mint case', async () => {
    tagAc(AC_FAIL_SURFACE);
    const installMcp = vi.fn(() => ({ ok: false, error: 'EACCES: permission denied', path: '/home/u/.claude.json' }));
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp });

    render(<DesktopMcpSection />);
    await clickInstall();

    const surface = await screen.findByTestId('mcp-install-error');
    expect(surface).toHaveTextContent(/config|write|file|\.claude\.json|permission/i);
    // It is NOT the mint/auth message.
    expect(surface).not.toHaveTextContent(/session expired/i);
  });

  it('Retry re-runs the install — a transient failure then succeeds', async () => {
    tagAc(AC_FAIL_SURFACE);
    const installMcp = vi
      .fn()
      .mockReturnValueOnce({ ok: false, error: 'disk full', path: '/p' })
      .mockReturnValueOnce({ ok: true, name: 'Claude Code', path: '/p', backupPath: '/p.bak' });
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp, showNotification: () => ({ ok: true }) });

    render(<DesktopMcpSection />);
    await clickInstall();

    const surface = await screen.findByTestId('mcp-install-error');
    fireEvent.click(within(surface).getByRole('button', { name: /retry/i }));

    // The success status replaces the error surface.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Restart Claude Code/),
    );
    expect(screen.queryByTestId('mcp-install-error')).toBeNull();
    expect(installMcp).toHaveBeenCalledTimes(2);
  });

  it('Copy details copies a diagnostic (config path + underlying error + app/OS) and NEVER the secret token', async () => {
    tagAc(AC_FAIL_SURFACE);
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const installMcp = vi.fn(() => ({ ok: false, error: 'EACCES: permission denied', path: '/home/u/.claude.json' }));
    installShell({ mcpStatus: () => STATUS_ABSENT, installMcp });

    render(<DesktopMcpSection />);
    await clickInstall();

    const surface = await screen.findByTestId('mcp-install-error');
    fireEvent.click(within(surface).getByRole('button', { name: /copy details/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const diag = writeText.mock.calls[0][0] as string;
    // Diagnostic carries the load-bearing facts…
    expect(diag).toContain('/home/u/.claude.json');
    expect(diag).toContain('EACCES: permission denied');
    expect(diag).toMatch(/Claude Code/);
    // …and the navigator userAgent (app/OS) is included.
    expect(diag).toContain(navigator.userAgent);
    // SECURITY: the secret session token must NEVER reach the clipboard.
    expect(diag).not.toContain('mxt_minted_secret_999');
    expect(diag).not.toContain('mxt_');
  });
});

describe('spec-304 ac-57 (dec-24): per-client "MCP status notification" toggle drives / hides the pill', () => {
  it('default ENABLED: Claude Code drives the pill (a real state is pushed, not a hide)', async () => {
    tagAc(AC_TOGGLE);
    installShell({ mcpStatus: () => STATUS_CC_READY });
    listMcpTokensApi.mockResolvedValue([
      { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt: null, revokedAt: null },
    ]);
    render(<DesktopMcpSection />);

    // The toggle is on by default…
    const toggle = await screen.findByRole('checkbox');
    expect(toggle).toBeChecked();
    // …and the pill is driven with the real "ready" state (never a hide).
    await waitFor(() => expect(mcpPushes.length).toBeGreaterThan(0));
    expect(mcpPushes.at(-1)?.kind).toBe('ready');
  });

  it('DISABLING it hides the pill ({kind:"none"}) while the inline status stays', async () => {
    tagAc(AC_TOGGLE);
    installShell({ mcpStatus: () => STATUS_CC_READY });
    listMcpTokensApi.mockResolvedValue([
      { id: '1', label: 'Memex Desktop', prefix: 'mxt_active123', lastUsedAt: null, revokedAt: null },
    ]);
    render(<DesktopMcpSection />);

    const toggle = await screen.findByRole('checkbox');
    await waitFor(() => expect(mcpPushes.length).toBeGreaterThan(0));
    fireEvent.click(toggle); // turn OFF

    // Claude Code no longer drives the pill → the explicit hide is pushed.
    await waitFor(() => expect(mcpPushes.at(-1)?.kind).toBe('none'));
    expect(toggle).not.toBeChecked();
    // The inline row status is unaffected — only the pill is silenced.
    expect(screen.getByTestId('mcp-status-claudeCode')).toHaveTextContent('MCP ready');
  });
});
