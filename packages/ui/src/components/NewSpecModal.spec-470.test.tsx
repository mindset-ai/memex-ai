// spec-470 t-2 — NewSpecModal's auto-send prop (dec-4). A seeded open dispatches
// the sentence as the agent's first turn with zero extra click (ac-7); it does so
// via a COMPOSED agent instruction, and the existing prefill/Issue path is left
// untouched (ac-8). The agent graph is mocked so `invoke` is an observable spy.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-470/acs';

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

beforeEach(() => {
  invokeMock.mockClear();
  resumeMock.mockClear();
});

describe('NewSpecModal auto-send (spec-470)', () => {
  it('ac-7: a seeded open auto-dispatches the sentence as the first turn — no extra click', async () => {
    tagAc(`${AC}/ac-7`);
    const sentence = 'A dashboard showing our signup funnel';
    renderModal({ seedMessage: sentence, autoSend: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    // The raw sentence shows as the user's first bubble (no manual Send).
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('ac-7: empty / whitespace seed neither dispatches nor shows a user turn', async () => {
    tagAc(`${AC}/ac-7`);
    renderModal({ seedMessage: '   ', autoSend: true });
    // Effects have flushed inside render()'s act(); assert no dispatch happened.
    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled());
  });

  it('ac-7: autoSend without a seed message is inert', async () => {
    tagAc(`${AC}/ac-7`);
    renderModal({ autoSend: true });
    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled());
  });

  it('ac-8: the dispatched turn is a COMPOSED instruction, not the raw sentence', async () => {
    tagAc(`${AC}/ac-8`);
    const sentence = 'A CLI that renames files by EXIF date';
    renderModal({ seedMessage: sentence, autoSend: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const arg = invokeMock.mock.calls[0][0] as { userMessage: string };
    // Composed wrapper (mirrors handleExplainSpec) — carries the sentence but is
    // NOT the bare sentence, and reads as a spec-drafting instruction.
    expect(arg.userMessage).toContain(sentence);
    expect(arg.userMessage).not.toBe(sentence);
    expect(arg.userMessage.toLowerCase()).toContain('spec');
  });

  it('ac-8: the existing prefill path is untouched — it seeds the textarea, never auto-sends', async () => {
    tagAc(`${AC}/ac-8`);
    renderModal({
      prefill: { title: 'Fix the flaky test', body: 'It fails on CI only', promoteFromIssueRef: 'r' },
    });

    // prefill only seeds the composer; the user must still press Send.
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textbox.value).toBe('Fix the flaky test\n\nIt fails on CI only');
    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled());
  });

  it('ac-8: prefill wins over autoSend when both are set (paths never both fire)', async () => {
    tagAc(`${AC}/ac-8`);
    renderModal({
      autoSend: true,
      seedMessage: 'should be ignored',
      prefill: { title: 'T', body: 'B', promoteFromIssueRef: 'r' },
    });
    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled());
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textbox.value).toBe('T\n\nB');
  });

  // spec-470 dec-4: opened from the flat /home hero (openOnCreate), the modal lands on
  // the Spec the instant it's created — no "Open Spec" click. Two things are proven:
  // (1) navigation is AUTOMATIC on create, and (2) with no URL tenant it must use the
  // caller-supplied specsBasePath — tenantPath() alone would yield an unroutable
  // /specs/{handle}. (Navigating away on create is also what beats the hero-unmount
  // race in the live flow — see the openOnCreate prop doc.)
  it('ac-2: openOnCreate lands on the new Spec under specsBasePath automatically (no click)', async () => {
    tagAc(`${AC}/ac-2`);
    // Make the fake agent report a confirmed create via the onDocCreated callback.
    invokeMock.mockImplementationOnce(
      async (params: { callbacks: { onDocCreated: (i: unknown) => void } }) => {
        params.callbacks.onDocCreated({ docId: 'd1', handle: 'spec-7', title: 'My Spec' });
        return { messages: [] };
      },
    );
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route
            path="/home"
            element={
              <NewSpecModal
                open
                onClose={() => {}}
                seedMessage="A CLI that tidies downloads"
                autoSend
                openOnCreate
                specsBasePath="/alice/personal/specs"
              />
            }
          />
          <Route
            path="/alice/personal/specs/spec-7"
            element={<div data-testid="spec-page" />}
          />
        </Routes>
      </MemoryRouter>,
    );

    // No "Open Spec" click — openOnCreate navigates on its own to the tenant-prefixed
    // spec URL, not the unroutable /specs/spec-7.
    expect(await screen.findByTestId('spec-page')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Spec/i })).not.toBeInTheDocument();
  });
});
