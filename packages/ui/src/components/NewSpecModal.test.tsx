import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-230 t-3: the modal navigates to the created Spec via useNavigate, so the
// component must render inside a Router. A bare <MemoryRouter> wrapper restores
// the production context (the modal is always mounted under the app Router).
function renderModal(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// Mock ONLY the network boundary (same pattern as ChatContext.streaming.test.tsx):
// the real useAgentGraph → graph → extractDocInfo path runs, so the doc_created
// transition is driven by the genuine parser against the genuine server string.
vi.mock('../agent/llm-client', () => ({
  callLlmProxy: vi.fn(),
  callLlmCreateProxy: vi.fn(),
  setLlmAuthToken: vi.fn(),
}));

vi.mock('../agent/tool-client', () => ({
  executeToolRemote: vi.fn(),
  setToolAuthToken: vi.fn(),
}));

import { NewSpecModal } from './NewSpecModal';
import { callLlmCreateProxy } from '../agent/llm-client';
import { executeToolRemote } from '../agent/tool-client';
import type { ContentBlock } from '../agent/types';

// spec-155 i-1 / t-5: the completed-state polish. ac-7 pins both halves —
// correct grammar in the footer notice, and no raw tool-result prose (the
// agent-facing Scope-AC nudge) surfaced in the modal chat.
const AC_POLISH =
  'mindset-prod/memex-building-itself/specs/spec-155/acs/ac-7';

// The real current server contract string, nudge included — exactly what
// executeToolRemote hands back in production (tool-specs.ts create_doc).
const SERVER_RESULT =
  'Spec created: ref: mindset-prod/memex-building-itself/specs/spec-9 "Polish Test".\n\n' +
  'Next: author Scope ACs for this Spec. Scope ACs are plain-English outcome commitments ' +
  'that define what success looks like — they ground every downstream Decision. Walk the ' +
  'user through 3–5 of them now via:\n  create_ac({ ref: "…", kind: "scope", statement: "..." })\n' +
  "Don't skip this in draft/specify. See get_information(topic='phases') for the full phase mechanics.";

async function* fakeStream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

function queueCreateFlow() {
  const createToolContent: ContentBlock[] = [
    {
      type: 'tool_use',
      id: 'ct-polish',
      name: 'create_doc',
      input: { title: 'Polish Test', purpose: 'Polish purpose', docType: 'spec' },
    },
  ];
  let call = 0;
  vi.mocked(callLlmCreateProxy).mockImplementation(() => {
    call++;
    return call === 1
      ? fakeStream([
          { type: 'message_complete', content: createToolContent, stopReason: 'tool_use' },
        ])
      : fakeStream([
          { type: 'text_delta', text: 'Your spec has been created.' },
          {
            type: 'message_complete',
            content: [{ type: 'text', text: 'Your spec has been created.' }],
            stopReason: 'end_turn',
          },
        ]);
  });
}

async function createSpecThroughModal() {
  renderModal(<NewSpecModal open onClose={vi.fn()} />);
  const user = userEvent.setup();
  await user.type(
    screen.getByPlaceholderText(/Describe the spec/i),
    'Create a spec called Polish Test'
  );
  await user.keyboard('{Enter}');
  // The doc_created card is the completed-state anchor.
  await waitFor(() => expect(screen.getByText('Polish Test')).toBeInTheDocument());
}

describe('NewSpecModal — completed-state polish (spec-155 i-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders grammatical completion copy: "Your spec is ready"', async () => {
    tagAc(AC_POLISH);
    queueCreateFlow();
    vi.mocked(executeToolRemote).mockResolvedValue(SERVER_RESULT);

    await createSpecThroughModal();

    await waitFor(() =>
      expect(
        screen.getByText(/Your spec is ready — open it to keep refining it\./)
      ).toBeInTheDocument()
    );
  });

  it('does not surface the raw create_doc result (the agent-facing Scope-AC nudge) in the chat', async () => {
    tagAc(AC_POLISH);
    queueCreateFlow();
    vi.mocked(executeToolRemote).mockResolvedValue(SERVER_RESULT);

    await createSpecThroughModal();

    // The completed state is conveyed by the doc_created card + footer notice;
    // the internal tool prose must never reach the human.
    expect(screen.queryByText(/author Scope ACs/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Spec created: ref:/)).not.toBeInTheDocument();
    // The tool line collapses to a compact completion marker instead.
    expect(screen.getByText(/Ran create_doc/)).toBeInTheDocument();
  });

  it('prefilled from an Issue: seeds the composer + threads promoteFromIssueRef into the create instruction (ac-19)', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-19');
    queueCreateFlow();
    vi.mocked(executeToolRemote).mockResolvedValue(SERVER_RESULT);
    const onCreated = vi.fn();

    renderModal(
      <NewSpecModal
        open
        onClose={vi.fn()}
        onCreated={onCreated}
        prefill={{
          title: 'Search returns stale hits',
          body: 'Re-running the same query shows yesterday’s results.',
          promoteFromIssueRef: 'acme/main/specs/spec-3/issues/issue-7',
        }}
      />,
    );

    // The composer is seeded with the Issue content so the user can elaborate.
    const composer = await screen.findByPlaceholderText(/Describe the spec/i);
    await waitFor(() =>
      expect(composer).toHaveValue(
        'Search returns stale hits\n\nRe-running the same query shows yesterday’s results.',
      ),
    );

    const user = userEvent.setup();
    await user.click(composer);
    await user.keyboard('{Enter}');

    // The first agent turn receives the composed message — which carries the
    // promoteFromIssueRef instruction so create_doc routes through the promote path.
    await waitFor(() => expect(callLlmCreateProxy).toHaveBeenCalled());
    const firstCallArgs = vi.mocked(callLlmCreateProxy).mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const lastUserMsg = firstCallArgs.messages[firstCallArgs.messages.length - 1];
    const composed =
      typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : JSON.stringify(lastUserMsg.content);
    expect(composed).toContain('Search returns stale hits');
    expect(composed).toContain('promoteFromIssueRef');
    expect(composed).toContain('acme/main/specs/spec-3/issues/issue-7');

    // onCreated fires only on the confirmed doc_created detection.
    await waitFor(() => expect(screen.getByText('Polish Test')).toBeInTheDocument());
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('still surfaces tool errors in the chat (failures must not be hidden)', async () => {
    tagAc(AC_POLISH);
    queueCreateFlow();
    vi.mocked(executeToolRemote).mockRejectedValue(new Error('boom'));

    renderModal(<NewSpecModal open onClose={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(/Describe the spec/i),
      'Create a spec called Polish Test'
    );
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByText(/Error: boom/)).toBeInTheDocument()
    );
  });
});

// spec-230 t-3 (ac-9): the post-creation state no longer dead-ends on a Close
// button — the user lands on the populated Spec. A primary "Open Spec" action
// (and the clickable doc_created card) navigate to /specs/<handle>.
const AC_LAND_ON_SPEC =
  'mindset-prod/memex-building-itself/specs/spec-230/acs/ac-9';

describe('NewSpecModal — lands the user on the populated Spec (spec-230 t-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function LocationProbe() {
    const loc = useLocation();
    return <div data-testid="loc">{loc.pathname}</div>;
  }

  it('offers "Open Spec" on completion and navigates to /specs/<handle>', async () => {
    tagAc(AC_LAND_ON_SPEC);
    queueCreateFlow();
    vi.mocked(executeToolRemote).mockResolvedValue(SERVER_RESULT);

    render(
      <MemoryRouter initialEntries={['/start']}>
        <NewSpecModal open onClose={vi.fn()} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(/Describe the spec/i),
      'Create a spec called Polish Test',
    );
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByText('Polish Test')).toBeInTheDocument());

    // The dead-end is gone: a primary "Open Spec" action is present.
    const openBtn = await screen.findByRole('button', { name: /Open Spec/i });
    expect(screen.getByTestId('loc')).toHaveTextContent('/start');

    await user.click(openBtn);

    // The created Spec's handle (spec-9, parsed from the server result) drives nav.
    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/specs/spec-9'),
    );
  });

  it('the doc_created card is itself a link to the populated Spec', async () => {
    tagAc(AC_LAND_ON_SPEC);
    queueCreateFlow();
    vi.mocked(executeToolRemote).mockResolvedValue(SERVER_RESULT);

    render(
      <MemoryRouter initialEntries={['/start']}>
        <NewSpecModal open onClose={vi.fn()} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(/Describe the spec/i),
      'Create a spec called Polish Test',
    );
    await user.keyboard('{Enter}');

    const card = await screen.findByRole('button', { name: /Polish Test/i });
    await user.click(card);

    await waitFor(() =>
      expect(screen.getByTestId('loc')).toHaveTextContent('/specs/spec-9'),
    );
  });
});
