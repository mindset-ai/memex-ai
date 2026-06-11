import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { ChatPanel, makesCodeShapedClaims } from './ChatPanel';
import type { ChatMessage } from '../api/types';
import type { ReactElement } from 'react';

// Mock useChat to control ChatPanel state
const mockSendMessage = vi.fn();
const mockStopStreaming = vi.fn();
const mockClearChat = vi.fn();
const mockRespondToUiTool = vi.fn();

let mockChatState: {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  docId: string | null;
  doc: null;
  openCommentCount: number;
  contextChips: { type: string; id: string; label: string }[];
  respondedToolIds: Set<string>;
  // spec-143 t-4 (dec-6): drift mode makes the agent live without a bound doc.
  isDriftMode: boolean;
};

vi.mock('./ChatContext', () => ({
  useChat: () => ({
    ...mockChatState,
    sendMessage: mockSendMessage,
    stopStreaming: mockStopStreaming,
    clearChat: mockClearChat,
    respondToUiTool: mockRespondToUiTool,
  }),
}));

// Mock child components to avoid rendering full markdown/UI tool trees
vi.mock('./chat/ChatMarkdown', () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div data-testid="chat-markdown">{content}</div>,
}));

vi.mock('./chat/ContextChipBar', () => ({
  ContextChipBar: () => <div data-testid="context-chip-bar" />,
}));

vi.mock('./chat/ui-tools', () => ({
  UiToolRenderer: ({ toolName }: { toolName: string }) => <div data-testid="ui-tool">{toolName}</div>,
}));

// The grounding line's "connect a coding agent" link needs a router context.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatState = {
      messages: [],
      isStreaming: false,
      error: null,
      docId: 'doc-1',
      doc: null,
      openCommentCount: 0,
      contextChips: [],
      respondedToolIds: new Set(),
      isDriftMode: false,
    };
  });

  it('shows empty state prompt based on docId presence', () => {
    const { rerender } = render(<ChatPanel />);
    expect(screen.getByText('Ask a question about this Spec...')).toBeInTheDocument();

    mockChatState.docId = null;
    mockChatState.contextChips = [];
    rerender(
      <MemoryRouter>
        <ChatPanel />
      </MemoryRouter>,
    );
    expect(screen.getByText('Open a Spec to start chatting')).toBeInTheDocument();
  });

  // spec-143 t-4 (dec-6): in drift mode the agent is LIVE on arrival — the input
  // is enabled with NO bound doc and NO context chip (canChat true), so the
  // drift agent "comes to life" the moment the Drift Inbox mounts.
  it('enables the chat input in drift mode with no doc and no chip (ac-12)', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-143/acs/ac-12');
    mockChatState.docId = null;
    mockChatState.contextChips = [];
    mockChatState.isDriftMode = true;

    render(<ChatPanel />);

    // The input placeholder flips to the live prompt and the textarea is enabled.
    const textarea = screen.getByPlaceholderText('Ask me anything...');
    expect(textarea).not.toBeDisabled();
  });

  it('renders messages by role', () => {
    mockChatState.messages = [
      { id: '1', role: 'user', content: 'Hello', timestamp: new Date() },
      { id: '2', role: 'assistant', content: 'Hi there', timestamp: new Date() },
      { id: '3', role: 'tool_status', content: 'Running update_section...', toolName: 'update_section', toolId: 't1', timestamp: new Date() },
    ];

    render(<ChatPanel />);

    // User message
    expect(screen.getByText('Hello')).toBeInTheDocument();
    // Assistant rendered via ChatMarkdown mock
    expect(screen.getByTestId('chat-markdown')).toHaveTextContent('Hi there');
    // Tool status
    expect(screen.getByText('Running update_section...')).toBeInTheDocument();
  });

  it('send button is disabled when input is empty or streaming', async () => {
    render(<ChatPanel />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();
  });

  it('Enter sends message, Shift+Enter does not', async () => {
    const user = userEvent.setup();
    render(<ChatPanel />);

    const textarea = screen.getByPlaceholderText('Ask me anything...');

    // Type and press Shift+Enter — should NOT send
    await user.type(textarea, 'hello{Shift>}{Enter}{/Shift}');
    expect(mockSendMessage).not.toHaveBeenCalled();

    // Clear and type fresh, then press Enter
    await user.clear(textarea);
    await user.type(textarea, 'hello');
    await user.keyboard('{Enter}');
    expect(mockSendMessage).toHaveBeenCalledWith('hello');
  });

  it('shows stop button during streaming and clear button when messages exist', () => {
    mockChatState.isStreaming = true;
    mockChatState.messages = [
      { id: '1', role: 'user', content: 'Hello', timestamp: new Date() },
    ];

    const { rerender } = render(<ChatPanel />);

    // Stop button visible during streaming
    expect(screen.getByTitle('Stop generating')).toBeInTheDocument();
    // Clear button visible when messages exist
    expect(screen.getByText('Clear')).toBeInTheDocument();

    // Stop streaming
    mockChatState.isStreaming = false;
    rerender(
      <MemoryRouter>
        <ChatPanel />
      </MemoryRouter>,
    );
    expect(screen.queryByTitle('Stop generating')).not.toBeInTheDocument();
  });
});

// ── spec-247 dec-3: the assistant names itself and discloses its grounding ──
describe('ChatPanel — Spec assistant naming + grounding (spec-247)', () => {
  const AC247 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-247/acs/ac-${n}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatState = {
      messages: [],
      isStreaming: false,
      error: null,
      docId: 'doc-1',
      doc: null,
      openCommentCount: 0,
      contextChips: [],
      respondedToolIds: new Set(),
      isDriftMode: false,
    };
  });

  it('the header reads "Spec assistant · private chat" and "Private Agent" is gone (ac-11)', () => {
    tagAc(AC247(11));
    render(<ChatPanel />);

    expect(screen.getByText('Spec assistant')).toBeInTheDocument();
    expect(screen.getByText(/private chat/)).toBeInTheDocument();
    expect(screen.queryByText('Private Agent')).not.toBeInTheDocument();
  });

  it('the signed-out placeholder uses the same heading — no "Private Agent" anywhere (ac-11)', () => {
    tagAc(AC247(11));
    render(<ChatPanel isAuthenticated={false} />);

    expect(screen.getByText('Spec assistant')).toBeInTheDocument();
    expect(screen.queryByText('Private Agent')).not.toBeInTheDocument();
  });

  it('a permanent grounding line is visible without interaction and links to the connect flow (ac-12)', () => {
    tagAc(AC247(12));
    render(<ChatPanel />);

    const line = screen.getByTestId('chat-grounding-line');
    expect(line).toHaveTextContent(/Works on this spec/);
    expect(line).toHaveTextContent(/Hasn't read your code/);
    expect(line).toHaveTextContent(/over MCP/);
    const link = within(line).getByRole('link', { name: /connect a coding agent/i });
    expect(link).toHaveAttribute('href', '/settings/integrations');
  });

  it('code-shaped assistant output carries an adjacent grounding disclosure (ac-13)', () => {
    tagAc(AC247(13));
    mockChatState.messages = [
      {
        id: '1',
        role: 'assistant',
        content: 'You should change `packages/server/src/services/decisions.ts` at the resolve guard.',
        timestamp: new Date(),
      },
      {
        id: '2',
        role: 'assistant',
        content: 'Sounds good — let me know if you want anything else.',
        timestamp: new Date(),
      },
    ];

    render(<ChatPanel />);

    // Exactly one disclosure: adjacent to the code-shaped message only.
    const disclosures = screen.getAllByTestId('code-claim-disclosure');
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toHaveTextContent(/hasn't read your code/i);
  });

  it('makesCodeShapedClaims: code fences, file paths and implementation-AC talk trigger; prose does not (ac-13)', () => {
    tagAc(AC247(13));
    expect(makesCodeShapedClaims('Here:\n```ts\nconst a = 1;\n```')).toBe(true);
    expect(makesCodeShapedClaims('Edit src/components/AcPanel.tsx please')).toBe(true);
    expect(makesCodeShapedClaims('The file decisions.ts holds the guard')).toBe(true);
    expect(makesCodeShapedClaims('I created three implementation ACs for this decision')).toBe(true);
    expect(makesCodeShapedClaims('The overview section could be clearer about scope.')).toBe(false);
  });
});
