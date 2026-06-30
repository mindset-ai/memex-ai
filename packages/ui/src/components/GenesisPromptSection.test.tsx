import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { GenesisPromptSection } from './GenesisPromptSection';
import { mcpUrl } from '../utils/mcpUrl';

const AC_ENV_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-18';
const AC_STATIC = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-21';
// spec-430: Claude Code prompt = unified install + checkout plugin; Cursor = MCP-only.
const AC_9_430 = 'mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9';

// jsdom has no clipboard by default; the CopyButton calls navigator.clipboard.
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

function getPromptText(): string {
  // The prompt is the only <code> inside a <pre> in this section.
  const pre = document.querySelector('pre code');
  return pre?.textContent ?? '';
}

describe('spec-201: GenesisPromptSection', () => {
  it('renders the section heading and a copy-pasteable prompt block', () => {
    tagAc(AC_STATIC);
    render(<GenesisPromptSection />);
    expect(
      screen.getByRole('heading', { name: 'Set up with one prompt' })
    ).toBeInTheDocument();
    expect(document.querySelector('pre code')).not.toBeNull();
  });

  it('ac-21: is static copy only — a Copy control, no Run/Verify/Install action', () => {
    tagAc(AC_STATIC);
    render(<GenesisPromptSection />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    // No control that would execute or verify the bootstrap on the user's behalf.
    expect(screen.queryByRole('button', { name: /run|verify|install|connect/i })).toBeNull();
  });

  it('defaults to the Claude Code prompt — unified install + the checkout plugin (spec-430)', () => {
    tagAc(AC_9_430);
    render(<GenesisPromptSection />);
    const text = getPromptText();
    expect(text).toContain('npx -y memex-ai install');
    expect(text).toContain('claude plugin install memex-checkout@memex');
    expect(text).toContain('CLAUDE.md');
    expect(text).not.toContain('claude mcp add'); // superseded (dec-2)
  });

  it('switches to the Cursor prompt (.cursor/rules/memex.mdc) on tab change', () => {
    tagAc(AC_STATIC);
    render(<GenesisPromptSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    const text = getPromptText();
    expect(text).toContain('.cursor/rules/memex.mdc');
    expect(text).toContain('.cursor/mcp.json');
  });

  it('the checkout plugin is CLAUDE-CODE-ONLY — the Cursor prompt never mentions it (spec-430)', () => {
    tagAc(AC_9_430);
    render(<GenesisPromptSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    const text = getPromptText();
    expect(text).not.toContain('memex-ai install');
    expect(text).not.toContain('claude plugin');
    expect(text).not.toContain('memex-checkout');
  });

  it('ac-18: the rendered prompt embeds the environment-derived MCP URL (Cursor)', () => {
    tagAc(AC_ENV_DERIVED);
    render(<GenesisPromptSection />);
    // The Cursor prompt always embeds the MCP URL verbatim; the Claude Code prompt only
    // adds --api-base for non-prod (prod omits it as the CLI default), so the always-on
    // env-derivation check reads the Cursor tab.
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    expect(getPromptText()).toContain(mcpUrl);
    expect(mcpUrl.endsWith('/mcp')).toBe(true);
  });
});
