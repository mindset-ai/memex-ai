// spec-305 — the connect-agent step (OS + tool tailored MCP setup + live green-tick).
// ac-3  — the first real task is connecting the agent; the card lights up automatically
//         the moment the connection is detected, no manual confirmation.
// ac-12 — the live tick is driven by the mcp.connected milestone; the card reuses the
//         existing install instructions (no bespoke per-tool page to maintain).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const fetchJourneyStateApi = vi.hoisted(() => vi.fn());
vi.mock('../../api/journey', () => ({ fetchJourneyStateApi }));

import { ConnectAgentStep } from './ConnectAgentStep';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;
// spec-430 ac-9: the onboarding connect-agent step describes the NEW unified
// Claude Code install flow (npx -y memex-ai install → checkout plugin), gated so
// the plugin steps appear in the Claude Code path only.
const AC430 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-430/acs/ac-${n}`;

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });
});

describe('ConnectAgentStep', () => {
  // spec-430 supersedes spec-305's OS-pills + curl/irm installer assertion: the
  // unified `npx -y memex-ai install` command is OS-agnostic, so the OS selector is
  // gone and the Claude Code path now shows the install + the checkout plugin.
  it('renders the tool selector with the unified Claude Code install flow by default', () => {
    tagAc(AC(3));
    tagAc(AC(12));
    tagAc(AC430(9));
    render(<ConnectAgentStep preview />);
    expect(screen.getByTestId('journey-step-connect-agent')).toBeInTheDocument();
    expect(screen.getByTestId('tool-claude-code')).toBeInTheDocument();
    const instr = screen.getByTestId('connect-instructions').textContent ?? '';
    // The old curl/irm bootstrap one-liners are gone…
    expect(instr).not.toMatch(/install\.sh|install\.ps1/);
    // …replaced by the unified installer + the Claude-Code-only checkout plugin.
    expect(instr).toContain('npx -y memex-ai install');
    expect(instr).toContain('claude plugin marketplace add mindset-ai/memex-ai');
    expect(instr).toContain('claude plugin install memex-checkout@memex');
    // The per-OS "Your machine" selector no longer exists (command is OS-agnostic).
    expect(screen.queryByTestId('os-mac')).not.toBeInTheDocument();
  });

  it('gates the checkout plugin to Claude Code: Cursor stays MCP-only with no plugin steps (spec-430 ac-9)', () => {
    tagAc(AC(12));
    tagAc(AC430(9));
    render(<ConnectAgentStep preview />);
    fireEvent.click(screen.getByTestId('tool-cursor'));
    const instr = screen.getByTestId('connect-instructions').textContent ?? '';
    expect(instr).toMatch(/mcpServers|\/mcp/);
    // The Claude-Code-only plugin must NOT appear for Cursor.
    expect(instr).not.toContain('claude plugin');
    expect(instr).not.toContain('memex-checkout');
    expect(instr).not.toContain('npx -y memex-ai install');
  });

  it('Claude Desktop reuses the unified installer for the MCP but shows NO checkout plugin (spec-430 ac-9)', () => {
    tagAc(AC430(9));
    render(<ConnectAgentStep preview />);
    fireEvent.click(screen.getByTestId('tool-claude-desktop'));
    const instr = screen.getByTestId('connect-instructions').textContent ?? '';
    expect(instr).toContain('npx -y memex-ai install');
    // Plugin is Claude Code only — not shown for Claude Desktop.
    expect(instr).not.toContain('claude plugin');
    expect(instr).not.toContain('memex-checkout');
  });

  it('flips to the Memex-native reward state + latches when mcp.connected is detected', async () => {
    tagAc(AC(3));
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true } });
    const onConnected = vi.fn();
    render(<ConnectAgentStep onConnected={onConnected} />);
    expect(await screen.findByTestId('connect-reward')).toBeInTheDocument();
    expect(screen.getByTestId('connect-reward-prompt').textContent).toMatch(/get_information/);
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
  });

  it('auto-dismisses (advances) on the first tool call', async () => {
    tagAc(AC(3));
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true, mcpToolCalled: true } });
    const onComplete = vi.fn();
    render(<ConnectAgentStep onComplete={onComplete} />);
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2500 });
  });

  it('Next advances manually from the reward state', async () => {
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true } });
    const onComplete = vi.fn();
    render(<ConnectAgentStep onComplete={onComplete} />);
    fireEvent.click(await screen.findByTestId('connect-next'));
    expect(onComplete).toHaveBeenCalled();
  });

  it('in operator preview it is render-only: no polling, no advance', () => {
    render(<ConnectAgentStep preview />);
    expect(screen.getByTestId('connect-waiting')).toBeInTheDocument();
    expect(fetchJourneyStateApi).not.toHaveBeenCalled();
  });
});
