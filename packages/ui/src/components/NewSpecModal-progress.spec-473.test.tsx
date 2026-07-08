// spec-473 issue-9 — regression coverage for NewSpecModal's live "Building your
// Spec…" checklist. The onToolProgress callback UPSERTS a `tool_status` message
// keyed by toolId, rendering the label as a checklist line ("✓ ${label}"). A
// second event for the same toolId updates in place (no duplicate row); UI tools
// (UI_TOOL_NAMES) are skipped; and an onToolStart already-shown row is not
// duplicated when onToolProgress lands for the same toolId. Not AC-tagged.
//
// The agent graph is mocked so `invoke` is an observable spy — we grab the
// `callbacks` object the modal hands it and drive onToolProgress/onToolStart
// directly, then assert the rendered DOM (not internal state).
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCallbacks } from '../agent/graph';

const invokeMock = vi.fn(async () => ({ messages: [] }));
const resumeMock = vi.fn(async () => ({ messages: [] }));
vi.mock('../agent/useAgentGraph', () => ({
  useAgentGraph: () => ({ invoke: invokeMock, resume: resumeMock }),
}));

import { NewSpecModal } from './NewSpecModal';

function renderModal(props: Partial<React.ComponentProps<typeof NewSpecModal>>) {
  return render(
    <MemoryRouter>
      <NewSpecModal open onClose={() => {}} {...props} />
    </MemoryRouter>,
  );
}

// Render the modal with an auto-sent seed so dispatchMessage calls invoke, then
// return the AgentCallbacks the modal handed it — the seam driving the checklist.
async function renderAndCaptureCallbacks(): Promise<AgentCallbacks> {
  renderModal({ seedMessage: 'anything', autoSend: true });
  await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
  return (invokeMock.mock.calls[0][0] as { callbacks: AgentCallbacks }).callbacks;
}

beforeEach(() => {
  invokeMock.mockClear();
  resumeMock.mockClear();
});

describe('NewSpecModal onToolProgress checklist (spec-473 issue-9)', () => {
  it('renders one checklist line containing the label for a single onToolProgress', async () => {
    const callbacks = await renderAndCaptureCallbacks();

    act(() => {
      callbacks.onToolProgress('add_section', 'tool_1', 'Design & UX section');
    });

    expect(screen.getByText('✓ Design & UX section')).toBeInTheDocument();
  });

  it('upserts by toolId — two events for the SAME toolId render only ONE line', async () => {
    const callbacks = await renderAndCaptureCallbacks();

    act(() => {
      callbacks.onToolProgress('add_section', 'tool_1', 'Design & UX section');
    });
    act(() => {
      callbacks.onToolProgress('add_section', 'tool_1', 'Design & UX section');
    });

    expect(screen.getAllByText('✓ Design & UX section')).toHaveLength(1);
  });

  it('skips UI tools — a render_confirmation progress event renders NO checklist line', async () => {
    const callbacks = await renderAndCaptureCallbacks();

    act(() => {
      callbacks.onToolProgress('render_confirmation', 'tool_x', 'Confirm creation');
    });

    expect(screen.queryByText('✓ Confirm creation')).not.toBeInTheDocument();
  });

  it('does not duplicate a row: onToolStart then onToolProgress for the same toolId → one line', async () => {
    const callbacks = await renderAndCaptureCallbacks();

    act(() => {
      callbacks.onToolStart('add_section', 'tool_2');
    });
    // The start-time placeholder is shown…
    expect(screen.getByText('Running add_section...')).toBeInTheDocument();

    act(() => {
      callbacks.onToolProgress('add_section', 'tool_2', 'Design & UX section');
    });

    // …and onToolProgress updates that SAME row in place rather than adding another.
    expect(screen.queryByText('Running add_section...')).not.toBeInTheDocument();
    expect(screen.getAllByText('✓ Design & UX section')).toHaveLength(1);
  });
});
