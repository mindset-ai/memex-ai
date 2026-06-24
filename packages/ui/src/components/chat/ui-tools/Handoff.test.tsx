// spec-389 t-4 (dec-3): the Handoff render component — an honest, copyable
// cross-agent handoff. These tests pin that it renders the target + reason + the
// ready-to-paste prompt with a Copy button, and that the dispatcher routes
// 'render_handoff' to it.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { Handoff } from './Handoff';
import { UiToolRenderer } from './index';

const AC_HANDOFF =
  'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-11';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Handoff — copyable cross-agent handoff (ac-11)', () => {
  it('renders the target, reason, and the ready-to-paste prompt', () => {
    tagAc(AC_HANDOFF);
    render(
      <Handoff
        input={{
          target: 'standards agent',
          reason: "I can't create a Standard — the standards agent owns that.",
          prompt: 'Create a Standard that pins the retry policy…',
        }}
      />,
    );
    expect(screen.getByText(/Hand off to standards agent/i)).toBeInTheDocument();
    expect(
      screen.getByText(/I can't create a Standard/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Create a Standard that pins the retry policy/i),
    ).toBeInTheDocument();
  });

  it('copies the PROMPT (not the reason) to the clipboard', async () => {
    tagAc(AC_HANDOFF);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <Handoff
        input={{ target: 'drift agent', prompt: 'Resolve the open drift on std-7.' }}
      />,
    );
    await userEvent.click(screen.getByTestId('handoff-copy'));
    expect(writeText).toHaveBeenCalledWith('Resolve the open drift on std-7.');
    await waitFor(() =>
      expect(screen.getByTestId('handoff-copy')).toHaveTextContent('Copied'),
    );
  });

  it('the dispatcher routes render_handoff to the Handoff component', () => {
    tagAc(AC_HANDOFF);
    render(
      <UiToolRenderer
        toolName="render_handoff"
        toolId="tu-1"
        input={{ target: 'New Spec flow', prompt: 'Open a Spec for the migration.' }}
        disabled={false}
        onRespond={() => {}}
      />,
    );
    expect(screen.getByTestId('agent-handoff')).toBeInTheDocument();
    expect(screen.getByText(/Hand off to New Spec flow/i)).toBeInTheDocument();
  });
});
