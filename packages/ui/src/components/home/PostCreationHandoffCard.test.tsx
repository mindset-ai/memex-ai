// spec-482 — the post-creation handoff card (presentational; signals are props).
// ac-5  — 3-step "connect" (NEVER "install") card, with a one-click copy of this Spec's URL.
// ac-21 — lifecycle via props: full → ✓ Connected morph → collapse.
// ac-23 — reuses ConnectAgentStep's exported TOOLS / Instructions (one setup matrix).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { PostCreationHandoffCard } from './PostCreationHandoffCard';
import { TOOLS } from './ConnectAgentStep';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-482/acs/ac-${n}`;

const SPEC_URL = 'https://memex.ai/mindset-prod/memex-building-itself/specs/spec-482';

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

describe('PostCreationHandoffCard', () => {
  it('renders the 3-step card with "connect" wording (never "install" as the action verb) and copies the Spec URL', async () => {
    tagAc(AC(5));
    render(
      <PostCreationHandoffCard specUrl={SPEC_URL} mcpConnected={false} thisSpecConnected={false} />,
    );

    // Full card with all three sequenced steps.
    expect(screen.getByTestId('post-creation-handoff-card')).toBeInTheDocument();
    expect(screen.getByTestId('handoff-step-connect')).toBeInTheDocument();
    expect(screen.getByTestId('handoff-step-copy')).toBeInTheDocument();
    expect(screen.getByTestId('handoff-step-paste')).toBeInTheDocument();

    // Step 1 heading says "Connect the Memex MCP server".
    expect(screen.getByText('Connect the Memex MCP server')).toBeInTheDocument();

    // The action verb in the step HEADINGS is "connect", never "install".
    const headings = screen.getAllByRole('heading').map((h) => h.textContent ?? '');
    expect(headings.join(' ')).toMatch(/connect/i);
    expect(headings.join(' ').toLowerCase()).not.toContain('install');

    // One-click copy affordance writes the current Spec URL to the clipboard.
    const copyBtn = within(screen.getByTestId('handoff-spec-url')).getByText('Copy');
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SPEC_URL));
  });

  it('fires onCopySpecUrl after a successful Spec-URL copy', async () => {
    tagAc(AC(5));
    const onCopySpecUrl = vi.fn();
    render(
      <PostCreationHandoffCard
        specUrl={SPEC_URL}
        mcpConnected={false}
        thisSpecConnected={false}
        onCopySpecUrl={onCopySpecUrl}
      />,
    );
    fireEvent.click(within(screen.getByTestId('handoff-spec-url')).getByText('Copy'));
    await waitFor(() => expect(onCopySpecUrl).toHaveBeenCalled());
  });

  it('morphs to the ✓ Connected state when mcpConnected && !thisSpecConnected, and collapses when thisSpecConnected', () => {
    tagAc(AC(21));

    // Morph: MCP connected, Spec not yet handed off.
    const { rerender } = render(
      <PostCreationHandoffCard specUrl={SPEC_URL} mcpConnected thisSpecConnected={false} />,
    );
    expect(screen.getByTestId('handoff-connected')).toBeInTheDocument();
    expect(screen.getByText(/Connected — now paste your Spec URL/i)).toBeInTheDocument();
    // The full 3-step card is gone in the morph state (connect step dropped).
    expect(screen.queryByTestId('post-creation-handoff-card')).not.toBeInTheDocument();

    // Collapse: this Spec has been connected/handed off.
    rerender(<PostCreationHandoffCard specUrl={SPEC_URL} mcpConnected thisSpecConnected />);
    expect(screen.getByTestId('handoff-collapsed')).toBeInTheDocument();
    expect(screen.queryByTestId('handoff-connected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-creation-handoff-card')).not.toBeInTheDocument();
  });

  it('reuses ConnectAgentStep TOOLS + Instructions — renders every agent-picker option from TOOLS', () => {
    tagAc(AC(23));
    render(
      <PostCreationHandoffCard specUrl={SPEC_URL} mcpConnected={false} thisSpecConnected={false} />,
    );
    // Every tool from the shared TOOLS array is offered as a picker option.
    for (const t of TOOLS) {
      const btn = screen.getByTestId(`handoff-tool-${t.id}`);
      expect(btn).toBeInTheDocument();
      expect(btn.textContent).toContain(t.label);
    }
    // The reused per-tool Instructions render (Claude Code default → unified installer).
    expect(screen.getByTestId('claude-code-instructions')).toBeInTheDocument();
    const instr = screen.getByTestId('handoff-connect-instructions').textContent ?? '';
    expect(instr).toContain('npx -y memex-ai install');
  });
});
