import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { tagAc } from "@memex-ai-ac/vitest";
import { ChatPanel } from './ChatPanel';

// spec-247: the grounding line's "connect a coding agent" link needs a router.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}
import type { ChatMessage } from '../api/types';

// spec-111 t-9 — agent panel access states (dec-2):
//   ac-10: anonymous visitor → "Sign in to chat" placeholder, no agent access.
//   ac-11: signed-in non-member → working read-only agent (chat input usable,
//          read-only banner visible).
//   org member (defaults) → unchanged.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-111/acs/ac-${n}`;

const mockSendMessage = vi.fn();

let mockChatState: {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  docId: string | null;
  contextChips: { type: string; id: string; label: string }[];
  respondedToolIds: Set<string>;
};

vi.mock('./ChatContext', () => ({
  useChat: () => ({
    ...mockChatState,
    sendMessage: mockSendMessage,
    stopStreaming: vi.fn(),
    clearChat: vi.fn(),
    respondToUiTool: vi.fn(),
  }),
}));

// spec-283: ChatPanel now resolves Org scaffold appends for the idle review
// block via useOrgScaffoldBlocks (which calls useAuth). These access-state tests
// render ChatPanel without an AuthProvider, so mock the hook to an empty array.
vi.mock('../hooks/useOrgScaffoldBlocks', () => ({
  useOrgScaffoldBlocks: () => [],
}));

vi.mock('./chat/ChatMarkdown', () => ({
  ChatMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('./chat/ContextChipBar', () => ({
  ContextChipBar: () => <div data-testid="context-chip-bar" />,
}));
vi.mock('./chat/ui-tools', () => ({
  UiToolRenderer: ({ toolName }: { toolName: string }) => <div>{toolName}</div>,
}));
describe('ChatPanel access states (spec-111 t-9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatState = {
      messages: [],
      isStreaming: false,
      error: null,
      docId: 'doc-1',
      contextChips: [],
      respondedToolIds: new Set(),
    };
  });

  describe('ac-10: anonymous visitor → "Sign in to chat" placeholder', () => {
    it('renders the placeholder and no chat input when not authenticated', () => {
      tagAc(AC(10));
      render(<ChatPanel isAuthenticated={false} />);

      expect(screen.getByTestId('chat-signin-placeholder')).toBeInTheDocument();
      expect(screen.getByText('Sign in to chat')).toBeInTheDocument();
      // No agent access: the chat input is absent entirely.
      expect(screen.queryByTestId('chat-input')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    });

    it('offers the same Log in / Sign up buttons as the sidebar', () => {
      tagAc(AC(10));
      render(<ChatPanel isAuthenticated={false} />);
      // Reuses PublicAccessControls — both CTAs point at the identifier-first
      // /login page (with returnTo), not a bespoke handler.
      const login = screen.getByTestId('public-login-button');
      const signup = screen.getByTestId('public-signup-button');
      expect(login).toHaveTextContent('Log in');
      expect(signup).toHaveTextContent('Sign up');
      for (const link of [login, signup]) {
        expect(link.getAttribute('href') ?? '').toContain('/login?returnTo=');
      }
    });
  });

  describe('ac-11: signed-in non-member → working read-only agent', () => {
    it('renders an active chat with a read-only banner', () => {
      tagAc(AC(11));
      render(<ChatPanel isAuthenticated={true} readOnly={true} />);

      // No sign-in placeholder — the agent is active.
      expect(screen.queryByTestId('chat-signin-placeholder')).not.toBeInTheDocument();
      // Header is the standardized "Spec assistant" (spec-247 dec-3); read-only is surfaced by the
      // banner (not the header), so this state still reads as read-only.
      expect(screen.getByText('Spec assistant')).toBeInTheDocument();
      expect(screen.getByTestId('chat-readonly-banner')).toBeInTheDocument();
      // The agent still works — input + send are present and enabled
      // (reads/questions succeed; mutations are blocked server-side by t-4).
      const input = screen.getByTestId('chat-input');
      expect(input).toBeInTheDocument();
      expect(input).not.toBeDisabled();
    });
  });

  describe('org member (default props) → unchanged', () => {
    it('renders the full read+write agent with no read-only banner', () => {
      tagAc(AC(11));
      render(<ChatPanel />);

      expect(screen.queryByTestId('chat-signin-placeholder')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chat-readonly-banner')).not.toBeInTheDocument();
      expect(screen.getByText('Spec assistant')).toBeInTheDocument();
      expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    });
  });
});
