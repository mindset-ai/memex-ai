import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { AgentSetupSection } from './AgentSetupSection';
import { installBase, mcpUrl } from '../utils/mcpUrl';

// spec-452 implementation ACs (the surface-level ones; ac-11..17 live in genesisPrompt.test).
const S452 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-452/acs/ac-${n}`;
// Migrated coverage from the two sections this component replaced — keep these ACs alive.
const AC201_ENV = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-18';
const AC201_URL = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-15';
const AC201_MORE = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-16';
const AC201_CLAUDE = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-19';
const AC201_CURSOR = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-20';
const AC201_STATIC = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-21';
const AC430_9 = 'mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9';

// jsdom has no clipboard by default; the CopyButton calls navigator.clipboard.
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

// The active tab's primary prompt/URL is the first <pre><code> in the panel.
function firstCode(): string {
  return document.querySelector('pre code')?.textContent ?? '';
}

// Every rendered code block, joined — for asserting config content is present without
// tripping over getByText matching both a <pre> and its nested <code>.
function allCode(): string {
  return Array.from(document.querySelectorAll('pre code'))
    .map((c) => c.textContent ?? '')
    .join('\n');
}

beforeEach(() => {
  window.history.replaceState({}, '', '/settings/integrations');
});
afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('spec-452: AgentSetupSection is one tabbed, per-client surface', () => {
  it('ac-7: renders exactly five client tabs in order', () => {
    tagAc(S452(7));
    render(<AgentSetupSection />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Claude Code',
      'Cursor',
      'Copilot (VS Code)',
      'Claude Desktop',
      'Claude.ai (web)',
    ]);
  });

  it('ac-8: no duplicate "Copy install prompt for Claude Code" button, and the one prompt is the complete one (writes CLAUDE.md)', () => {
    tagAc(S452(8));
    render(<AgentSetupSection />);
    expect(screen.queryByRole('button', { name: /copy install prompt/i })).toBeNull();
    // The single surviving Claude Code prompt is the complete genesis one — it writes
    // the durable clause the old top-of-page INSTALL_PROMPT button omitted.
    expect(firstCode()).toContain('CLAUDE.md');
  });

  it('ac-9: defaults to the Claude Code tab', () => {
    tagAc(S452(9));
    render(<AgentSetupSection />);
    const cc = screen.getByRole('tab', { name: 'Claude Code' });
    expect(cc.getAttribute('aria-selected')).toBe('true');
    expect(firstCode()).toContain('npx -y memex-ai install');
  });

  it('ac-9: ?client=<id> selects the matching tab on load', () => {
    tagAc(S452(9));
    window.history.replaceState({}, '', '/settings/integrations?client=cursor');
    render(<AgentSetupSection />);
    expect(screen.getByRole('tab', { name: 'Cursor' }).getAttribute('aria-selected')).toBe('true');
    expect(firstCode()).toContain('.cursor/mcp.json');
  });

  it('ac-9: an unknown ?client value falls back to Claude Code', () => {
    tagAc(S452(9));
    window.history.replaceState({}, '', '/settings/integrations?client=emacs');
    render(<AgentSetupSection />);
    expect(screen.getByRole('tab', { name: 'Claude Code' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

describe('spec-201 / spec-430: coding-agent prompts (migrated from the two replaced sections)', () => {
  it('ac-21: static copy only — a Copy control, no Run/Verify/Install/Connect action', () => {
    tagAc(AC201_STATIC);
    render(<AgentSetupSection />);
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /run|verify|install|connect/i })).toBeNull();
  });

  it('ac-19 / ac-9: the Claude Code prompt drives the unified install + the checkout plugin + CLAUDE.md', () => {
    tagAc(AC201_CLAUDE);
    tagAc(AC430_9);
    render(<AgentSetupSection />);
    const text = firstCode();
    expect(text).toContain('npx -y memex-ai install');
    expect(text).toContain('claude plugin install memex-checkout@memex');
    expect(text).toContain('CLAUDE.md');
    expect(text).not.toContain('claude mcp add'); // superseded
  });

  it('ac-20: switching to Cursor shows the .cursor prompt', () => {
    tagAc(AC201_CURSOR);
    render(<AgentSetupSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    const text = firstCode();
    expect(text).toContain('.cursor/rules/memex.mdc');
    expect(text).toContain('.cursor/mcp.json');
  });

  it('ac-9: the checkout plugin is CLAUDE-CODE-ONLY — Cursor and Copilot prompts never mention it', () => {
    tagAc(AC430_9);
    render(<AgentSetupSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    expect(firstCode()).not.toContain('claude plugin');
    fireEvent.click(screen.getByRole('tab', { name: 'Copilot (VS Code)' }));
    const copilot = firstCode();
    expect(copilot).not.toContain('claude plugin');
    expect(copilot).not.toContain('memex-checkout');
    expect(copilot).toContain('.vscode/mcp.json');
    expect(copilot).toContain('.github/copilot-instructions.md');
  });

  it('ac-18: the rendered prompt embeds the environment-derived MCP URL (Cursor)', () => {
    tagAc(AC201_ENV);
    render(<AgentSetupSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    expect(firstCode()).toContain(mcpUrl);
    expect(mcpUrl.endsWith('/mcp')).toBe(true);
  });
});

describe('spec-201 / spec-253: web + native-IDE connect steps (migrated)', () => {
  it('ac-15: the web tab shows the derived MCP URL (installBase + /mcp), not a hardcoded host', () => {
    tagAc(AC201_URL);
    render(<AgentSetupSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Claude.ai (web)' }));
    expect(firstCode()).toBe(`${installBase}/mcp`);
  });

  it('ac-16: the web tab has a claude.ai custom-connector flow, and Cursor a manual config with the derived URL', () => {
    tagAc(AC201_MORE);
    render(<AgentSetupSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Claude.ai (web)' }));
    expect(screen.getByText(/Add custom connector/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    fireEvent.click(screen.getByRole('button', { name: /show manual setup/i }));
    expect(screen.getByText(/Prefer to edit config directly/)).toBeInTheDocument();
    expect(allCode()).toContain('"mcpServers"');
    expect(allCode()).toContain(`${installBase}/mcp`);
  });

  it('spec-253: the Copilot tab carries the VS Code servers/type:http config and names Windsurf/Zed', () => {
    render(<AgentSetupSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Copilot (VS Code)' }));
    fireEvent.click(screen.getByRole('button', { name: /show manual setup/i }));
    // The Windsurf/Zed note lives ONLY in the manual disclosure — proves it opened.
    expect(screen.getByText(/Windsurf and Zed/)).toBeInTheDocument();
    expect(allCode()).toContain('"servers"');
    expect(allCode()).toContain('"type": "http"');
    expect(allCode()).toContain(`${installBase}/mcp`);
  });
});
