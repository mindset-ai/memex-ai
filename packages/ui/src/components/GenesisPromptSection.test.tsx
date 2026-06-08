import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { GenesisPromptSection } from './GenesisPromptSection';
import { mcpUrl } from '../utils/mcpUrl';

const AC_ENV_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-18';
const AC_STATIC = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-21';

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

  it('defaults to the Claude Code prompt (claude mcp add + CLAUDE.md)', () => {
    tagAc(AC_STATIC);
    render(<GenesisPromptSection />);
    const text = getPromptText();
    expect(text).toContain('claude mcp add');
    expect(text).toContain('CLAUDE.md');
  });

  it('switches to the Cursor prompt (.cursor/rules/memex.mdc) on tab change', () => {
    tagAc(AC_STATIC);
    render(<GenesisPromptSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'Cursor' }));
    const text = getPromptText();
    expect(text).toContain('.cursor/rules/memex.mdc');
    expect(text).toContain('.cursor/mcp.json');
  });

  it('ac-18: the rendered prompt embeds the environment-derived MCP URL', () => {
    tagAc(AC_ENV_DERIVED);
    render(<GenesisPromptSection />);
    expect(getPromptText()).toContain(mcpUrl);
    expect(mcpUrl.endsWith('/mcp')).toBe(true);
  });
});
