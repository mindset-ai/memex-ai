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

beforeEach(() => {
  fetchJourneyStateApi.mockReset();
  fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: false } });
});

describe('ConnectAgentStep', () => {
  it('renders OS pills + tool selector with the Claude Code installer by default', () => {
    tagAc(AC(3));
    tagAc(AC(12));
    render(<ConnectAgentStep preview />);
    expect(screen.getByTestId('journey-step-connect-agent')).toBeInTheDocument();
    expect(screen.getByTestId('os-mac')).toBeInTheDocument();
    expect(screen.getByTestId('tool-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('connect-instructions').textContent).toMatch(/install\.sh|install\.ps1/);
  });

  it('switching tool to Cursor swaps the instructions and drops the OS pills', () => {
    tagAc(AC(12));
    render(<ConnectAgentStep preview />);
    fireEvent.click(screen.getByTestId('tool-cursor'));
    expect(screen.getByTestId('connect-instructions').textContent).toMatch(/mcpServers|\/mcp/);
    // OS only matters for the terminal installer, not the JSON-config clients.
    expect(screen.queryByTestId('os-mac')).not.toBeInTheDocument();
  });

  it('lights the green tick and advances when mcp.connected is detected', async () => {
    tagAc(AC(3));
    fetchJourneyStateApi.mockResolvedValue({ milestones: { mcpConnected: true } });
    const onComplete = vi.fn();
    render(<ConnectAgentStep onComplete={onComplete} />);
    expect(await screen.findByTestId('connect-connected')).toBeInTheDocument();
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2500 });
  });

  it('in operator preview it is render-only: no polling, no advance', () => {
    render(<ConnectAgentStep preview />);
    expect(screen.getByTestId('connect-waiting')).toBeInTheDocument();
    expect(fetchJourneyStateApi).not.toHaveBeenCalled();
  });
});
