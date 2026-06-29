import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { CliInstallSection } from './CliInstallSection';
import { installBase, mcpUrl } from '../utils/mcpUrl';

const AC_URL_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-15';
const AC_MORE_CLIENTS = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-16';
// spec-430 ac-9: the Integrations install section describes the unified Claude Code
// flow (npx -y memex-ai install → checkout plugin), with the Claude-Code-only plugin
// kept out of the OAuth-on-connect "Other clients" (Cursor / VS Code / web) guidance.
const AC430_9 = 'mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9';

describe('spec-201 ac-15: connect instructions derive the MCP URL from the environment', () => {
  it('renders the MCP URL as installBase + /mcp, not a hardcoded host', () => {
    tagAc(AC_URL_DERIVED);
    render(<CliInstallSection />);
    // The "Other clients" block shows the derived MCP URL in its own code block.
    expect(screen.getByText(`${installBase}/mcp`)).toBeInTheDocument();
    expect(mcpUrl).toBe(`${installBase}/mcp`);
  });
});

describe('spec-201 ac-16: claude.ai web + Cursor connect steps', () => {
  it('includes a claude.ai (web) connect block', () => {
    tagAc(AC_MORE_CLIENTS);
    render(<CliInstallSection />);
    expect(screen.getByRole('heading', { name: 'claude.ai (web)' })).toBeInTheDocument();
    expect(screen.getByText(/Add custom connector/)).toBeInTheDocument();
  });

  it('includes a Cursor connect block with the derived URL in its config', () => {
    tagAc(AC_MORE_CLIENTS);
    render(<CliInstallSection />);
    expect(screen.getByRole('heading', { name: 'Cursor' })).toBeInTheDocument();
    const cursorConfig = screen.getByText(/"mcpServers"[\s\S]*"memex"[\s\S]*\/mcp/);
    expect(cursorConfig.textContent).toContain(`${installBase}/mcp`);
  });

  it('exposes a copy control for the MCP URL', () => {
    tagAc(AC_MORE_CLIENTS);
    render(<CliInstallSection />);
    // The derived-URL block and the Cursor config each carry a Copy button.
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThanOrEqual(2);
  });
});

// spec-253 t-5 (dec-3): the connect panel covers native IDEs beyond Cursor —
// VS Code gets its own block, and the framing names the OAuth-on-connect set.
// Smoke check that the artifact actually renders the new content.
describe('spec-253: native-IDE OAuth connect steps (VS Code)', () => {
  it('includes a VS Code connect block with the derived URL in its config', () => {
    render(<CliInstallSection />);
    expect(screen.getByRole('heading', { name: 'VS Code' })).toBeInTheDocument();
    const vscodeConfig = screen.getByText(/"servers"[\s\S]*"memex"[\s\S]*\/mcp/);
    expect(vscodeConfig.textContent).toContain(`${installBase}/mcp`);
  });

  it('frames the OAuth-on-connect clients as native IDEs (Cursor, VS Code, Windsurf, Zed)', () => {
    render(<CliInstallSection />);
    expect(screen.getByText(/Cursor, VS Code, Windsurf, Zed/)).toBeInTheDocument();
  });
});

// spec-430: the Claude Code install is now the unified `npx -y memex-ai install`
// (one sign-in → MCP token + checkout key) plus the Claude-Code-ONLY spec-checkout
// plugin. The plugin must NOT appear in the OAuth-on-connect "Other clients" block.
describe('spec-430 ac-9: unified Claude Code install + Claude-Code-gated checkout plugin', () => {
  it('shows the unified installer and the checkout plugin under a Claude Code heading', () => {
    tagAc(AC430_9);
    render(<CliInstallSection />);
    const cc = screen.getByRole('heading', { name: 'Claude Code' });
    expect(cc).toBeInTheDocument();
    // The unified installer (one sign-in → MCP token + checkout key) appears — it's
    // referenced more than once (the command block + the Claude Desktop footnote).
    expect(screen.getAllByText(/npx -y memex-ai install/).length).toBeGreaterThanOrEqual(1);
    // …and the two Claude-Code-only plugin commands (in one code block).
    const plugin = screen.getByText(/claude plugin marketplace add mindset-ai\/memex-ai/);
    expect(plugin.textContent).toContain('claude plugin install memex-checkout@memex');
  });

  it('does NOT surface the checkout plugin in the OAuth-on-connect Other clients block', () => {
    tagAc(AC430_9);
    render(<CliInstallSection />);
    // The plugin is Claude Code only — it must not appear in the Cursor/VS Code/web copy.
    const others = document.getElementById('other-clients');
    expect(others).not.toBeNull();
    expect(others?.textContent ?? '').not.toContain('memex-checkout');
    expect(others?.textContent ?? '').not.toContain('claude plugin');
  });

  it('drops the old curl/irm install.sh bootstrap one-liner (superseded by the unified installer)', () => {
    tagAc(AC430_9);
    render(<CliInstallSection />);
    expect(screen.queryByText(/install\.sh|install\.ps1/)).toBeNull();
  });
});
