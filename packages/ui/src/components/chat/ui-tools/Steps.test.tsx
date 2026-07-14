// spec-482 dec-10 (ac-26): render_steps gains an optional per-step ATOMIC copyable.
// These tests pin that a step's Copy button copies EXACTLY that step's `copy` value —
// never the label, the detail, or another step's value — and that steps without `copy`
// render no button (backward-compatible). This is what lets the connect handoff live in
// ONE card with a per-step copy each, instead of one blob-copying render_handoff.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { Steps } from './Steps';
import { UiToolRenderer } from './index';

const AC_STEP_COPY =
  'mindset-prod/memex-building-itself/specs/spec-482/acs/ac-26';

// The three-step connect handoff shape (dec-10): connect command, Spec URL, paste-prompt.
const CONNECT_STEPS = [
  {
    label: 'Connect your coding agent over MCP',
    detail: 'A one-time step so your agent can read and build from this Spec.',
    copy: 'npx -y memex-ai install --api-base https://int.memex.ai',
    copyLabel: 'Copy command',
  },
  {
    label: 'Give your agent this Spec',
    detail: 'Its address on Memex.',
    copy: 'https://int.memex.ai/acme/checkout/specs/spec-2',
    copyLabel: 'Copy URL',
  },
  {
    label: 'Tell it to build from the Spec',
    copy: 'Use the Memex MCP on this Spec: https://int.memex.ai/acme/checkout/specs/spec-2',
    copyLabel: 'Copy prompt',
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Steps — atomic per-step copy (ac-26)', () => {
  it('renders each step with its own labelled Copy button', () => {
    tagAc(AC_STEP_COPY);
    render(<Steps input={{ title: 'Get spec-2 ready to build', steps: CONNECT_STEPS }} />);
    expect(screen.getByText(/Connect your coding agent over MCP/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy command:/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy URL:/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy prompt:/ })).toBeInTheDocument();
    // Three copyable steps → three buttons, each its own chip.
    expect(screen.getAllByTestId('step-copy-button')).toHaveLength(3);
  });

  it("a step's Copy copies EXACTLY that step's value — not the label, detail, or another step", async () => {
    tagAc(AC_STEP_COPY);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<Steps input={{ steps: CONNECT_STEPS }} />);

    // Copy step 1 (the command) — clipboard gets ONLY the command, nothing bundled.
    await userEvent.click(screen.getByRole('button', { name: /Copy command:/ }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenLastCalledWith(
      'npx -y memex-ai install --api-base https://int.memex.ai',
    );

    // Copy step 2 (the URL) — clipboard gets ONLY the URL, not the command.
    await userEvent.click(screen.getByRole('button', { name: /Copy URL:/ }));
    expect(writeText).toHaveBeenLastCalledWith(
      'https://int.memex.ai/acme/checkout/specs/spec-2',
    );

    // Copy step 3 (the paste-prompt) — the ready-to-paste sentence only.
    await userEvent.click(screen.getByRole('button', { name: /Copy prompt:/ }));
    expect(writeText).toHaveBeenLastCalledWith(
      'Use the Memex MCP on this Spec: https://int.memex.ai/acme/checkout/specs/spec-2',
    );

    // No copy ever carried a step label or detail — every clipboard write is one of the
    // three atomic values, never the surrounding prose.
    for (const call of writeText.mock.calls) {
      expect(call[0]).not.toContain('Connect your coding agent');
      expect(call[0]).not.toContain('A one-time step');
    }
  });

  it("clicking Copy shows 'Copied' on that step only", async () => {
    tagAc(AC_STEP_COPY);
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<Steps input={{ steps: CONNECT_STEPS }} />);
    const buttons = screen.getAllByTestId('step-copy-button');
    await userEvent.click(buttons[1]!);
    await waitFor(() => expect(buttons[1]!).toHaveTextContent('Copied'));
    // The other steps keep their own labels — the confirmation is per-step.
    expect(buttons[0]!).toHaveTextContent('Copy command');
    expect(buttons[2]!).toHaveTextContent('Copy prompt');
  });

  it('steps without a `copy` render no Copy button (backward-compatible)', () => {
    tagAc(AC_STEP_COPY);
    render(
      <Steps
        input={{
          steps: [
            { label: 'Plain step one', detail: 'no copyable here' },
            { label: 'Plain step two' },
          ],
        }}
      />,
    );
    expect(screen.getByText('Plain step one')).toBeInTheDocument();
    expect(screen.queryByTestId('step-copy-button')).not.toBeInTheDocument();
  });

  it('the dispatcher routes render_steps (with copy) to the Steps component', () => {
    tagAc(AC_STEP_COPY);
    render(
      <UiToolRenderer
        toolName="render_steps"
        toolId="tu-1"
        input={{ steps: CONNECT_STEPS }}
        disabled={false}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Copy command:/ })).toBeInTheDocument();
  });
});
