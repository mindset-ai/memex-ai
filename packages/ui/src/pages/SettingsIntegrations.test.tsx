import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { acEmitterManifest } from '@memex/shared';
import { mcpUrl } from '../utils/mcpUrl';

const AC_CONSOLIDATED = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-3';
const SCOPE = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-201/acs/ac-${n}`;

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

vi.mock('../hooks/useUserChangeStream', () => ({
  useUserChangeStream: () => {},
}));

vi.mock('../api/client', () => ({
  getSlackStatusApi: vi.fn(async () => []),
  disconnectSlackApi: vi.fn(async () => {}),
  listMcpTokensApi: vi.fn(async () => []),
  revokeMcpTokenApi: vi.fn(async () => {}),
}));

import { SettingsIntegrations } from './SettingsIntegrations';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/integrations']}>
      <SettingsIntegrations />
    </MemoryRouter>
  );
}

describe('spec-141 ac-3: consolidated Integrations page', () => {
  it('renders the page under a single Integrations heading', async () => {
    tagAc(AC_CONSOLIDATED);
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Integrations', level: 1 })
    ).toBeInTheDocument();
  });

  it('composes the Slack, MCP-tokens, and setup sections', async () => {
    tagAc(AC_CONSOLIDATED);
    renderPage();
    // All three section headings render regardless of async load state.
    expect(await screen.findByRole('heading', { name: 'Slack' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MCP Tokens' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Set up Memex' })).toBeInTheDocument();
  });

  it('spec-452 ac-10: the setup surface and MCP Tokens are separate sections; the desktop installer stays browser-hidden', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-452/acs/ac-10');
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Set up Memex' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MCP Tokens' })).toBeInTheDocument();
    // DesktopMcpSection renders only inside the desktop shell — it is browser-hidden here.
    expect(
      screen.queryByRole('heading', { name: 'Install Memex MCP on this device' })
    ).toBeNull();
  });

  it('ac-6: composes the spec-201 "Install the AC emitter" section', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-201/acs/ac-6');
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Install the AC emitter' })
    ).toBeInTheDocument();
  });
});

// Scope ACs (manager-authored outcomes). These are deliberately page-level
// integration assertions — they verify the whole Integrations surface delivers
// the promised outcome, not a single component's internals (those are the
// implementation ACs ac-6..ac-16). ac-5 is NOT here: it asserts spec-73's
// document content, which lives in the Memex, not this repo — see the spec-201
// handover note for its (doc-state) disposition.
describe('spec-201 scope ACs: the Integrations page as one discoverable setup surface', () => {
  it('ac-1: one discoverable surface covers BOTH connecting an agent and installing the AC emitter', async () => {
    tagAc(SCOPE(1));
    renderPage();
    // Reachable as a single page (the member-visible /settings/integrations).
    expect(
      await screen.findByRole('heading', { name: 'Integrations', level: 1 })
    ).toBeInTheDocument();
    // Connect-an-agent content (the one tabbed setup surface)…
    expect(screen.getByRole('heading', { name: 'Set up Memex' })).toBeInTheDocument();
    // …and install-the-emitter content, on the same surface.
    expect(screen.getByRole('heading', { name: 'Install the AC emitter' })).toBeInTheDocument();
  });

  it('ac-2: per-client tabs name all five clients, with the env-derived MCP URL + copy', async () => {
    tagAc(SCOPE(2));
    renderPage();
    await screen.findByRole('heading', { name: 'Set up Memex' });
    // All five clients are named as tabs on the surface.
    const tabNames = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabNames).toEqual(
      expect.arrayContaining([
        'Claude Code',
        'Cursor',
        'Copilot (VS Code)',
        'Claude Desktop',
        'Claude.ai (web)',
      ]),
    );
    // On the web tab, the MCP URL shown is the env-derived one (not a hardcoded host),
    // with a live copy control.
    fireEvent.click(screen.getByRole('tab', { name: 'Claude.ai (web)' }));
    expect(screen.getAllByText(mcpUrl).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0);
  });

  it('ac-3: AC-emitter install instructions — command, MEMEX_EMIT_KEY, Emission Keys deep link, tagAc example', async () => {
    tagAc(SCOPE(3));
    renderPage();
    await screen.findByRole('heading', { name: 'Install the AC emitter' });
    const vitest = acEmitterManifest.find((a) => a.status === 'available')!;
    expect(screen.getByText(vitest.installCommand)).toBeInTheDocument();
    expect(screen.getByText(/MEMEX_EMIT_KEY=/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Emission Keys' })).toBeInTheDocument();
    const codeBlocks = Array.from(document.querySelectorAll('pre code'))
      .map((b) => b.textContent ?? '')
      .join('\n');
    expect(codeBlocks).toContain('tagAc(');
  });

  it('ac-4: per-language adapter matrix sourced from the shared manifest (one row per entry, statuses shown)', async () => {
    tagAc(SCOPE(4));
    renderPage();
    await screen.findByRole('heading', { name: 'Install the AC emitter' });
    // Every adapter in the manifest is rendered — the matrix is data-sourced, not hardcoded.
    for (const adapter of acEmitterManifest) {
      expect(screen.getByText(adapter.package)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Available').length).toBeGreaterThan(0);
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });
});
