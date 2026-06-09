import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { CliInstallSection } from './CliInstallSection';
import { installBase, mcpUrl } from '../utils/mcpUrl';

const AC_URL_DERIVED = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-15';
const AC_MORE_CLIENTS = 'mindset-prod/memex-building-itself/specs/spec-201/acs/ac-16';

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
