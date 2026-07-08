// spec-473 t-3 — NewSpecModal's seedKind='document' framing (dec-3, ac-9). The
// new-home IMPORT hero hands over an existing document; the modal must dispatch a
// "convert this document into a structured Spec" instruction (NOT the idea framing),
// carrying the document, while the default 'idea' path is left exactly as spec-470
// shipped it. The agent graph is mocked so `invoke` is an observable spy.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = 'mindset-prod/memex-building-itself/specs/spec-473/acs';

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

const DOC = [
  '# Realtime Presence PRD',
  '## Problem',
  "Users can't tell who else is viewing a document.",
  '## Goals',
  '- Show avatars of active viewers.',
].join('\n');

describe('NewSpecModal seedKind=document (spec-473)', () => {
  it("ac-9: a document seed dispatches a 'convert this document into a structured Spec' instruction carrying the document", async () => {
    tagAc(`${AC}/ac-9`);
    renderModal({ seedMessage: DOC, seedKind: 'document', autoSend: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const arg = invokeMock.mock.calls[0][0] as { userMessage: string };
    // The document rides inline…
    expect(arg.userMessage).toContain('Realtime Presence PRD');
    // …but the instruction is a CONVERT-a-document framing, not the idea framing.
    expect(arg.userMessage.toLowerCase()).toContain('convert');
    expect(arg.userMessage.toLowerCase()).toContain('structured spec');
    expect(arg.userMessage.toLowerCase()).toContain('acceptance criteria');
    // Explicitly NOT the spec-470 idea wrapper.
    expect(arg.userMessage).not.toContain('idea in one sentence');
  });

  it('ac-9: the document is shown as a short label + attachment, not a giant raw bubble', async () => {
    tagAc(`${AC}/ac-9`);
    renderModal({ seedMessage: DOC, seedKind: 'document', autoSend: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    // A concise user-facing label stands in for the whole document…
    expect(screen.getByText('Turn this document into a Spec.')).toBeInTheDocument();
    // …so the raw markdown heading is not rendered verbatim as the bubble text.
    expect(screen.queryByText(DOC)).not.toBeInTheDocument();
  });

  it("ac-9: the default 'idea' framing is unchanged (no regression for spec-470 / prefill callers)", async () => {
    tagAc(`${AC}/ac-9`);
    const sentence = 'A CLI that renames files by EXIF date';
    // seedKind omitted ⇒ defaults to 'idea'.
    renderModal({ seedMessage: sentence, autoSend: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    const arg = invokeMock.mock.calls[0][0] as { userMessage: string };
    expect(arg.userMessage).toContain(sentence);
    expect(arg.userMessage).toContain('idea in one sentence');
    expect(arg.userMessage.toLowerCase()).not.toContain('convert it into');
    // The raw sentence is the user bubble on the idea path.
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it('ac-9: empty/whitespace document neither dispatches nor shows a user turn', async () => {
    tagAc(`${AC}/ac-9`);
    renderModal({ seedMessage: '   \n  ', seedKind: 'document', autoSend: true });
    await waitFor(() => expect(invokeMock).not.toHaveBeenCalled());
  });
});
