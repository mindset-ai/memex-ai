import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { ClaudeConnectorDialog } from './ClaudeConnectorDialog';

// t-56 → dec-23 / ac-55: the Claude Desktop "Install for my org" connector
// dialog — env-derived URL + copy + steps + admin note + honest-CTA copy.
const AC_DIALOG =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-55';

// t-63 → issue-29 / ac-60: Claude Desktop moved the connector UI. The steps
// must reflect the current flow (Customize → Connectors → "+") rather than the
// stale "Settings → Connectors → Add custom connector".
const AC_STEPS_CURRENT =
  'mindset-prod/memex-building-itself/specs/spec-304/acs/ac-60';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('spec-304 ac-55 (t-56): Claude Desktop connector-instructions dialog', () => {
  it('shows the env-derived connector URL, the add-connector steps, and the Team/Enterprise admin note', () => {
    tagAc(AC_DIALOG);
    render(
      <ClaudeConnectorDialog connectorUrl="https://int.memex.ai/mcp" onClose={() => {}} />,
    );

    // The env-derived URL (int here; prod would be https://memex.ai/mcp).
    expect(screen.getByTestId('connector-url')).toHaveTextContent('https://int.memex.ai/mcp');
    // Step-by-step add-a-connector instructions.
    expect(screen.getByText(/Add custom connector/i)).toBeInTheDocument();
    expect(screen.getByText(/Individual sign-in/i)).toBeInTheDocument();
    // The Team/Enterprise admin-only note (Owner adds; members sign in).
    expect(screen.getByText(/only a workspace\s*Owner can add/i)).toBeInTheDocument();
  });

  it('reads as honest guidance to set up INSIDE Claude (std-34), not an in-app install', () => {
    tagAc(AC_DIALOG);
    render(
      <ClaudeConnectorDialog connectorUrl="https://memex.ai/mcp" onClose={() => {}} />,
    );
    // The honest-CTA signal: Memex can't add it for you; you add it in Claude.
    expect(screen.getByText(/Memex can’t add it for you/i)).toBeInTheDocument();
  });

  it('copies the connector URL to the clipboard', async () => {
    tagAc(AC_DIALOG);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <ClaudeConnectorDialog connectorUrl="https://memex.ai/mcp" onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy URL' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://memex.ai/mcp'));
    expect(await screen.findByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('uses the current Claude Desktop flow: Customize → Connectors → "+" (ac-60)', () => {
    tagAc(AC_STEPS_CURRENT);
    render(
      <ClaudeConnectorDialog connectorUrl="https://memex.ai/mcp" onClose={() => {}} />,
    );

    // Step 1 now routes through Customize → Connectors (Claude moved it out of
    // Settings). The stale "Settings → Connectors" wording must be gone.
    expect(screen.getByText(/Customize/)).toBeInTheDocument();
    expect(screen.queryByText(/Settings → Connectors/)).not.toBeInTheDocument();

    // The new intermediate step: click the "+" next to Connectors before
    // "Add custom connector".
    const steps = screen.getByRole('list');
    expect(steps.textContent ?? '').toMatch(/\+\s*next to Connectors/i);
    expect(screen.getByText(/Add custom connector/i)).toBeInTheDocument();

    // std-1: no user-visible "account"/"team" in the steps copy.
    expect(steps.textContent ?? '').not.toMatch(/\baccount\b|\bteam\b/i);
  });

  it('Escape and the Done button both close the dialog', () => {
    tagAc(AC_DIALOG);
    const onClose = vi.fn();
    render(
      <ClaudeConnectorDialog connectorUrl="https://memex.ai/mcp" onClose={onClose} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
