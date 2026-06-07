import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';

// Mock the LLM and tool clients before importing graph
vi.mock('./llm-client', () => ({
  callLlmProxy: vi.fn(),
  callLlmCreateProxy: vi.fn(),
  setLlmAuthToken: vi.fn(),
}));

vi.mock('./tool-client', () => ({
  executeToolRemote: vi.fn(),
  setToolAuthToken: vi.fn(),
}));

import { createAgentGraph, routeByPhase, extractDocInfo } from './graph';
import type { AgentCallbacks, PhaseAgentName } from './graph';
import { callLlmProxy, callLlmCreateProxy } from './llm-client';
import { executeToolRemote } from './tool-client';
import type { MessageParam, ContentBlock } from './types';

// Helper to create an async generator from an array of events
async function* fakeStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

describe('LangGraph agent graph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a user message through the agent node and returns assistant response', async () => {
    const textContent: ContentBlock[] = [{ type: 'text', text: 'Hello back!' }];

    vi.mocked(callLlmProxy).mockReturnValue(
      fakeStream([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' back!' },
        { type: 'message_complete', content: textContent, stopReason: 'end_turn' },
      ])
    );

    const callbacks: AgentCallbacks = {
      onTextDelta: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Hi' }], docId: 'doc-123' },
      {
        configurable: {
          thread_id: 'test-1',
          callbacks,
        },
      }
    );

    // Verify messages: user + assistant
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hi' });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: textContent });

    // Verify streaming callbacks were called
    expect(callbacks.onTextDelta).toHaveBeenCalledWith('Hello');
    expect(callbacks.onTextDelta).toHaveBeenCalledWith(' back!');
  });

  it('executes server tools and loops back to agent', async () => {
    const toolUseContent: ContentBlock[] = [
      { type: 'text', text: 'Let me update that section.' },
      // Canonical ref + content — entity-acting tools take a single `ref` per T-1/T-6.
      { type: 'tool_use', id: 'tool-1', name: 'update_section', input: { ref: 'ns/mx/specs/spec-1/sections/s-1', content: 'New' } },
    ];

    const finalContent: ContentBlock[] = [{ type: 'text', text: 'Section updated.' }];

    // First call: returns tool_use
    // Second call (after tool result): returns text only
    let callCount = 0;
    vi.mocked(callLlmProxy).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fakeStream([
          { type: 'text_delta', text: 'Let me update that section.' },
          { type: 'message_complete', content: toolUseContent, stopReason: 'tool_use' },
        ]);
      }
      return fakeStream([
        { type: 'text_delta', text: 'Section updated.' },
        { type: 'message_complete', content: finalContent, stopReason: 'end_turn' },
      ]);
    });

    vi.mocked(executeToolRemote).mockResolvedValue('Section updated (abc).');

    const callbacks: AgentCallbacks = {
      onTextDelta: vi.fn(),
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Update section abc' }], docId: 'doc-123' },
      {
        configurable: {
          thread_id: 'test-2',
          callbacks,
        },
      }
    );

    // Messages: user → assistant (tool_use) → user (tool_result) → assistant (final)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('user');
    expect(result.messages[3].role).toBe('assistant');

    // Verify tool was executed
    expect(executeToolRemote).toHaveBeenCalledWith(
      'update_section',
      { ref: 'ns/mx/specs/spec-1/sections/s-1', content: 'New' },
      undefined,
      'doc-123',
      // spec-143 t-4 (dec-6): toolsNode forwards the agent mode; undefined in
      // the default (non-drift) spec flow.
      undefined
    );
    expect(callbacks.onToolStart).toHaveBeenCalledWith('update_section', 'tool-1');
    expect(callbacks.onToolResult).toHaveBeenCalledWith('tool-1', 'Section updated (abc).');

    // LLM called twice (initial + after tool result)
    expect(callLlmProxy).toHaveBeenCalledTimes(2);
  });

  it('exits graph for UI tools without executing them server-side', async () => {
    const uiToolContent: ContentBlock[] = [
      { type: 'text', text: 'Shall I proceed?' },
      {
        type: 'tool_use',
        id: 'tool-2',
        name: 'render_confirmation',
        input: { message: 'Delete this section?' },
      },
    ];

    vi.mocked(callLlmProxy).mockReturnValue(
      fakeStream([
        { type: 'text_delta', text: 'Shall I proceed?' },
        { type: 'message_complete', content: uiToolContent, stopReason: 'tool_use' },
      ])
    );

    const callbacks: AgentCallbacks = {
      onTextDelta: vi.fn(),
      onUiTool: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Delete section 1' }], docId: 'doc-123' },
      {
        configurable: {
          thread_id: 'test-3',
          callbacks,
        },
      }
    );

    // Graph exits with just user + assistant (no tool execution loop)
    expect(result.messages).toHaveLength(2);

    // UI tool callback was fired
    expect(callbacks.onUiTool).toHaveBeenCalledWith(
      'render_confirmation',
      'tool-2',
      { message: 'Delete this section?' }
    );

    // Server tool executor was NOT called
    expect(executeToolRemote).not.toHaveBeenCalled();

    // LLM was only called once (no loop)
    expect(callLlmProxy).toHaveBeenCalledTimes(1);
  });

  it('handles tool execution errors gracefully', async () => {
    const toolUseContent: ContentBlock[] = [
      { type: 'tool_use', id: 'tool-err', name: 'update_section', input: { ref: 'ns/mx/specs/spec-1/sections/s-99', content: 'noop' } },
    ];
    const errorFollowUp: ContentBlock[] = [{ type: 'text', text: 'That section was not found.' }];

    let callCount = 0;
    vi.mocked(callLlmProxy).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return fakeStream([
          { type: 'message_complete', content: toolUseContent, stopReason: 'tool_use' },
        ]);
      }
      return fakeStream([
        { type: 'message_complete', content: errorFollowUp, stopReason: 'end_turn' },
      ]);
    });

    vi.mocked(executeToolRemote).mockRejectedValue(new Error('Section not found'));

    const callbacks: AgentCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Update bad section' }], docId: 'doc-123' },
      {
        configurable: {
          thread_id: 'test-4',
          callbacks,
        },
      }
    );

    // Tool result should contain error
    const toolResultMsg = result.messages[2];
    expect(toolResultMsg.role).toBe('user');
    const toolResultBlock = (toolResultMsg.content as ContentBlock[])[0];
    expect(toolResultBlock.type).toBe('tool_result');
    expect((toolResultBlock as any).content).toBe('Error: Section not found');
    expect((toolResultBlock as any).is_error).toBe(true);

    expect(callbacks.onToolResult).toHaveBeenCalledWith('tool-err', 'Error: Section not found');
  });

  it('does not duplicate messages when invoked with existing conversation history', async () => {
    // BUG CHECK: The reducer is (prev, update) => [...prev, ...update].
    // If we pass existingMessages=[msg1, msg2] as input, the reducer merges
    // default ([]) with input ([msg1, msg2]) = [msg1, msg2]. Then the agent
    // node returns { messages: [assistantMsg] }, and the reducer merges
    // [msg1, msg2] with [assistantMsg] = [msg1, msg2, assistantMsg].
    // This is correct — but only if invoke is called with a fresh thread_id
    // each time (no checkpointer state carries over).

    const existingMessages: MessageParam[] = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: [{ type: 'text', text: 'First reply' }] },
    ];

    vi.mocked(callLlmProxy).mockReturnValue(
      fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'Second reply' }], stopReason: 'end_turn' },
      ])
    );

    const graph = createAgentGraph();
    const result = await graph.invoke(
      {
        messages: [
          ...existingMessages,
          { role: 'user', content: 'Second message' },
        ],
        docId: 'doc-123',
      },
      {
        configurable: { thread_id: 'dedup-test-1', callbacks: {} },
      }
    );

    // Should be: existing[0], existing[1], new user, new assistant = 4
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'First message' });
    expect(result.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'First reply' }] });
    expect(result.messages[2]).toEqual({ role: 'user', content: 'Second message' });
    expect(result.messages[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Second reply' }] });

    // Verify the LLM received all messages (history + new)
    const proxyCalls = vi.mocked(callLlmProxy).mock.calls;
    expect(proxyCalls[0][0].messages).toHaveLength(3); // existing 2 + new user
  });

  it('does not leak messages between different thread_ids', async () => {
    vi.mocked(callLlmProxy).mockReturnValue(
      fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'Reply' }], stopReason: 'end_turn' },
      ])
    );

    const graph = createAgentGraph();

    // First thread
    const result1 = await graph.invoke(
      { messages: [{ role: 'user', content: 'Thread A' }], docId: 'doc-123' },
      { configurable: { thread_id: 'thread-A', callbacks: {} } }
    );
    expect(result1.messages).toHaveLength(2);

    // Second thread — should NOT include Thread A messages
    const result2 = await graph.invoke(
      { messages: [{ role: 'user', content: 'Thread B' }], docId: 'doc-123' },
      { configurable: { thread_id: 'thread-B', callbacks: {} } }
    );
    expect(result2.messages).toHaveLength(2);
    expect(result2.messages[0]).toEqual({ role: 'user', content: 'Thread B' });
  });

  it('exits graph for mixed server + UI tools so ChatContext can handle all results', async () => {
    // When assistant calls both server and UI tools, the graph must EXIT
    // (not enter tools node) so that ChatContext can:
    // 1. Render the UI tool for user interaction
    // 2. Execute server tools via REST
    // 3. Send ALL tool_results together (Anthropic requires this)

    const mixedToolContent: ContentBlock[] = [
      { type: 'tool_use', id: 'srv-1', name: 'update_section', input: { ref: 'ns/mx/specs/spec-1/sections/s-1', content: 'noop' } },
      { type: 'tool_use', id: 'ui-1', name: 'render_confirmation', input: { message: 'Sure?' } },
    ];

    vi.mocked(callLlmProxy).mockReturnValue(
      fakeStream([
        { type: 'message_complete', content: mixedToolContent, stopReason: 'tool_use' },
      ])
    );

    const callbacks: AgentCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onUiTool: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Do both' }], docId: 'doc-123' },
      { configurable: { thread_id: 'mixed-test', callbacks } }
    );

    // Graph should exit with just user + assistant (no tools node execution)
    expect(result.messages).toHaveLength(2);

    // Server tool was NOT executed by the graph (ChatContext will do it on resume)
    expect(executeToolRemote).not.toHaveBeenCalled();
    expect(callbacks.onToolStart).not.toHaveBeenCalled();

    // UI tool WAS notified via callback (so ChatContext can render it)
    expect(callbacks.onUiTool).toHaveBeenCalledWith('render_confirmation', 'ui-1', { message: 'Sure?' });

    // LLM was only called once (no loop)
    expect(callLlmProxy).toHaveBeenCalledTimes(1);
  });

  it('passes docId to LLM proxy', async () => {
    vi.mocked(callLlmProxy).mockReturnValue(
      fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
      ])
    );

    const graph = createAgentGraph();
    await graph.invoke(
      { messages: [{ role: 'user', content: 'Hi' }], docId: 'doc-123' },
      {
        configurable: {
          thread_id: 'test-5',
        },
      }
    );

    expect(callLlmProxy).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'doc-123' }),
      undefined
    );
  });

  // ──────────────────────────────────────────────
  // Creation phase tests
  // ──────────────────────────────────────────────

  it('routes to createDoc when docId is null', async () => {
    vi.mocked(callLlmCreateProxy).mockReturnValue(
      fakeStream([
        { type: 'text_delta', text: 'What type of doc?' },
        { type: 'message_complete', content: [{ type: 'text', text: 'What type of doc?' }], stopReason: 'end_turn' },
      ])
    );

    const callbacks: AgentCallbacks = { onTextDelta: vi.fn() };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Create a new doc' }], docId: null },
      { configurable: { thread_id: 'create-1', callbacks } }
    );

    // Used creation proxy, not main proxy
    expect(callLlmCreateProxy).toHaveBeenCalledTimes(1);
    expect(callLlmProxy).not.toHaveBeenCalled();

    // Messages: user + assistant
    expect(result.messages).toHaveLength(2);
    expect(result.docId).toBeNull();
  });

  it('stays in creation phase after create_doc and fires onDocCreated', async () => {
    // spec-155 — the parser-drift bug. ac-4 (dec-1): given the server's CURRENT
    // create_doc output, extractDocInfo carries the canonical ref as docId so
    // onDocCreated fires (the modal's create detection). ac-6 (dec-3): this test
    // pins the literal live server string — a future prefix/format rename fails
    // here loudly instead of silently stranding the modal. ac-3 (scope): the
    // re-drift tripwire is this pinned contract.
    tagAc('mindset-prod/memex-building-itself/specs/spec-155/acs/ac-4');
    tagAc('mindset-prod/memex-building-itself/specs/spec-155/acs/ac-6');
    tagAc('mindset-prod/memex-building-itself/specs/spec-155/acs/ac-3');

    // createDoc node: LLM calls create_doc tool
    const createToolContent: ContentBlock[] = [
      { type: 'tool_use', id: 'ct-1', name: 'create_doc', input: { title: 'My Spec', purpose: 'Define API', docType: 'spec' } },
    ];

    // After tool execution, loops back to createDoc node (stays in creation phase)
    const followUpContent: ContentBlock[] = [{ type: 'text', text: 'Your document has been created! You can view it from the document list.' }];

    let createCallCount = 0;
    vi.mocked(callLlmCreateProxy).mockImplementation(() => {
      createCallCount++;
      if (createCallCount === 1) {
        return fakeStream([
          { type: 'message_complete', content: createToolContent, stopReason: 'tool_use' },
        ]);
      }
      return fakeStream([
        { type: 'text_delta', text: 'Your document has been created!' },
        { type: 'message_complete', content: followUpContent, stopReason: 'end_turn' },
      ]);
    });

    // The real current server contract (tool-specs.ts create_doc): a canonical
    // ref, no UUID, prefixed `Spec created: ref:` and trailed by the Scope-AC
    // nudge. Pinning the literal string here so a future prefix/format change
    // can't silently re-break the modal's create detection (the b-36 → b-105
    // drift this test exists to catch).
    vi.mocked(executeToolRemote).mockResolvedValue(
      'Spec created: ref: mindset-prod/memex-building-itself/specs/spec-1 "My Spec".\n\nNext: author Scope ACs for this Spec.'
    );

    const callbacks: AgentCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
      onDocCreated: vi.fn(),
      onTextDelta: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'Create a spec about APIs' }], docId: null },
      { configurable: { thread_id: 'create-2', callbacks } }
    );

    // create_doc was executed
    expect(executeToolRemote).toHaveBeenCalledWith('create_doc', { title: 'My Spec', purpose: 'Define API', docType: 'spec' }, undefined);

    // onDocCreated callback fired with the extracted doc info. In the ref-only
    // shape there's no UUID to surface, so docId carries the canonical ref and
    // handle carries the trailing `spec-N`.
    expect(callbacks.onDocCreated).toHaveBeenCalledWith({
      docId: 'mindset-prod/memex-building-itself/specs/spec-1',
      handle: 'spec-1',
      title: 'My Spec',
    });

    // docId stays null in state — user hasn't navigated yet
    expect(result.docId).toBeNull();

    // Stayed in creation phase — only callLlmCreateProxy was used, never callLlmProxy
    expect(callLlmCreateProxy).toHaveBeenCalledTimes(2);
    expect(callLlmProxy).not.toHaveBeenCalled();

    // Messages: user → assistant (tool_use) → user (tool_result) → assistant (follow-up)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toEqual({ role: 'assistant', content: followUpContent });
  });

  // ──────────────────────────────────────────────
  // extractDocInfo — every parse branch, directly (spec-155 dec-2 / ac-5)
  // ──────────────────────────────────────────────
  describe('extractDocInfo create-result parser (spec-155)', () => {
    const SPEC155 = 'mindset-prod/memex-building-itself/specs/spec-155';
    // ac-5 (implementation, dec-2): the tolerant parser matches a
    // Document|Brief|Spec prefix with an optional `ref:` token across all three
    // shapes — legacy uuid, canonical path, bare handle — and returns null on
    // non-matching input.
    const AC_TOLERANT_PARSER = `${SPEC155}/acs/ac-5`;
    // ac-3 (scope): create-detection recognises today's string AND the
    // historical variants.
    const AC_NO_SILENT_REDRIFT = `${SPEC155}/acs/ac-3`;

    it('parses the current canonical-ref shape (Spec created: ref: <path>)', () => {
      tagAc(AC_TOLERANT_PARSER);
      tagAc(AC_NO_SILENT_REDRIFT);
      expect(
        extractDocInfo(
          'Spec created: ref: mindset-prod/memex-building-itself/specs/spec-1 "My Spec".\n\nNext: author Scope ACs for this Spec.'
        )
      ).toEqual({
        docId: 'mindset-prod/memex-building-itself/specs/spec-1',
        handle: 'spec-1',
        title: 'My Spec',
      });
    });

    it('parses the legacy uuid shape (Document created: <handle> (uuid: …))', () => {
      tagAc(AC_TOLERANT_PARSER);
      tagAc(AC_NO_SILENT_REDRIFT);
      expect(
        extractDocInfo(
          'Document created: spec-7 (uuid: 123e4567-e89b-12d3-a456-426614174000) "Old Shape". You can view it now.'
        )
      ).toEqual({
        docId: '123e4567-e89b-12d3-a456-426614174000',
        handle: 'spec-7',
        title: 'Old Shape',
      });
    });

    it('parses the brief-era noun (Brief created: ref: <path>)', () => {
      tagAc(AC_TOLERANT_PARSER);
      tagAc(AC_NO_SILENT_REDRIFT);
      expect(
        extractDocInfo(
          'Brief created: ref: mindset-int/memex-app/briefs/b-42 "Brief Era".'
        )
      ).toEqual({
        docId: 'mindset-int/memex-app/briefs/b-42',
        handle: 'b-42',
        title: 'Brief Era',
      });
    });

    it('parses the slug-less bare-handle fallback (ref: spec-N)', () => {
      tagAc(AC_TOLERANT_PARSER);
      expect(extractDocInfo('Spec created: ref: spec-9 "Bare Handle".')).toEqual({
        docId: 'spec-9',
        handle: 'spec-9',
        title: 'Bare Handle',
      });
    });

    it('accepts the prefix without a ref: token', () => {
      tagAc(AC_TOLERANT_PARSER);
      expect(
        extractDocInfo(
          'Spec created: mindset-prod/memex-building-itself/specs/spec-3 "No Ref Token".'
        )
      ).toEqual({
        docId: 'mindset-prod/memex-building-itself/specs/spec-3',
        handle: 'spec-3',
        title: 'No Ref Token',
      });
    });

    it('returns null on non-matching input', () => {
      tagAc(AC_TOLERANT_PARSER);
      expect(extractDocInfo('Error: a doc with that title already exists.')).toBeNull();
      expect(extractDocInfo('Widget created: ref: spec-1 "Wrong Noun".')).toBeNull();
      expect(extractDocInfo('')).toBeNull();
    });

    // spec-158 t-5 / ac-19: create_doc's promote paths (promoteFromIssueRef /
    // promoteFromTaskRef) don't say "<noun> created:" — they say
    // "Promoted issue issue-N to Spec ref: <ref> "<title>"." The Issues page's
    // Convert-to-Spec relies on this still parsing so onDocCreated fires and the
    // list refetches; without it the conversion is invisible client-side.
    it('parses the promote-from-issue shape (Promoted issue … to Spec ref: <path>)', () => {
      tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-19');
      expect(
        extractDocInfo(
          'Promoted issue issue-7 to Spec ref: acme/main/specs/spec-9 "Search fix".'
        )
      ).toEqual({
        docId: 'acme/main/specs/spec-9',
        handle: 'spec-9',
        title: 'Search fix',
      });
    });

    it('parses the verbose promote-from-issue shape (child Spec ref:)', () => {
      tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-19');
      expect(
        extractDocInfo(
          'Promoted Issue issue-7 to child Spec ref: acme/main/specs/spec-9 "Search fix" (parent: spec-3). Issue → converted; auto-resolves when the child Spec reaches done.'
        )
      ).toEqual({
        docId: 'acme/main/specs/spec-9',
        handle: 'spec-9',
        title: 'Search fix',
      });
    });

    it('parses the promote shape with a bare-handle fallback', () => {
      tagAc('mindset-prod/memex-building-itself/specs/spec-158/acs/ac-19');
      expect(
        extractDocInfo('Promoted issue issue-7 to Spec ref: spec-9 "Search fix".')
      ).toEqual({
        docId: 'spec-9',
        handle: 'spec-9',
        title: 'Search fix',
      });
    });
  });

  it('stays in creation phase when LLM gathers info without calling tools', async () => {
    // LLM asks a question — no tools called, graph exits for user to respond
    vi.mocked(callLlmCreateProxy).mockReturnValue(
      fakeStream([
        { type: 'message_complete', content: [{ type: 'text', text: 'What should the title be?' }], stopReason: 'end_turn' },
      ])
    );

    const graph = createAgentGraph();
    const result = await graph.invoke(
      { messages: [{ role: 'user', content: 'I need a new document' }], docId: null },
      { configurable: { thread_id: 'create-3', callbacks: {} } }
    );

    // Still in creation phase — docId still null
    expect(result.docId).toBeNull();
    expect(callLlmCreateProxy).toHaveBeenCalledTimes(1);
    expect(callLlmProxy).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────
  // Per-phase routing (dec-1 of doc-12)
  // ──────────────────────────────────────────────

  describe('routeByPhase', () => {
    const baseState = {
      messages: [] as MessageParam[],
    };

    it('routes to createDoc when docId is null regardless of phase', () => {
      expect(
        routeByPhase({ ...baseState, docId: null, specPhase: 'build' })
      ).toBe('createDoc');
      expect(
        routeByPhase({ ...baseState, docId: null, specPhase: null })
      ).toBe('createDoc');
    });

    // spec-143 t-4 (dec-6): drift mode has no bound doc but is NOT creation —
    // it routes straight to an agent node (planAgent / the generic agentNode),
    // never createDoc. The drift posture comes from the server-side prompt +
    // tool subset selected by mode 'drift', not a distinct client node.
    it('routes to an agent node (not createDoc) in drift mode even with no docId', () => {
      expect(
        routeByPhase({ ...baseState, docId: null, specPhase: null, agentMode: 'drift' })
      ).toBe('planAgent');
    });

    it('routes to the matching per-phase agent for each SpecPhase', () => {
      // `draft` is a Spec attribute / Kanban column, not a graph node —
      // it routes to planAgent (collapsed in b-33). The dedicated test
      // task (t-6) will add explicit assertions for the draft→planAgent
      // collapse.
      const cases = [
        ['draft', 'planAgent'],
        ['specify', 'planAgent'],
        ['build', 'buildAgent'],
        ['verify', 'verifyAgent'],
        ['done', 'doneAgent'],
      ] as const;
      for (const [phase, expected] of cases) {
        expect(
          routeByPhase({ ...baseState, docId: 'doc-1', specPhase: phase })
        ).toBe(expected);
      }
    });

    it('falls back to planAgent when specPhase is null on an existing doc', () => {
      // Safe default: existing docs without a known phase are treated as
      // specify, which matches the old single-node behaviour.
      expect(
        routeByPhase({ ...baseState, docId: 'doc-1', specPhase: null })
      ).toBe('planAgent');
    });

    // b-33 / s-3 reconciliation — `draft` is a Spec attribute / Kanban
    // column, NOT a graph node. The collapse means switching status from
    // `draft` to `specify` (or back) must NOT trigger a node switch — both
    // resolve to the same agent so the agent's behavioural surface is
    // unchanged at that transition.
    it('returns the same agent for draft and specify (draft → specify is a no-op for routing)', () => {
      const draftTarget = routeByPhase({ ...baseState, docId: 'doc-1', specPhase: 'draft' });
      const planTarget = routeByPhase({ ...baseState, docId: 'doc-1', specPhase: 'specify' });
      expect(draftTarget).toBe(planTarget);
      expect(draftTarget).toBe('planAgent');
    });

    it('routes each non-draft phase to its dedicated agent (regression — collapse must not affect build/verify/done)', () => {
      // Belt-and-braces: the draftAgent removal in b-33 must not silently
      // re-route any of the other arms. Explicit per-phase assertions.
      expect(
        routeByPhase({ ...baseState, docId: 'doc-1', specPhase: 'build' })
      ).toBe('buildAgent');
      expect(
        routeByPhase({ ...baseState, docId: 'doc-1', specPhase: 'verify' })
      ).toBe('verifyAgent');
      expect(
        routeByPhase({ ...baseState, docId: 'doc-1', specPhase: 'done' })
      ).toBe('doneAgent');
    });
  });

  // ──────────────────────────────────────────────
  // Graph topology — draftAgent removal (b-33 / s-3)
  // ──────────────────────────────────────────────

  describe('graph topology — draftAgent removal', () => {
    it('PhaseAgentName union does not include draftAgent', () => {
      // The PhaseAgentName type is a const string-literal union. We can't
      // introspect the union at runtime, but we can assert the full set of
      // expected values via a typed const that would fail compilation if
      // PhaseAgentName ever grew/shrank without updating this test.
      const expectedPhaseAgents: readonly PhaseAgentName[] = [
        'planAgent',
        'buildAgent',
        'verifyAgent',
        'doneAgent',
      ] as const;

      // Build-time check: the literal 'draftAgent' is not assignable to
      // PhaseAgentName. If draftAgent were re-added to the union, the
      // following @ts-expect-error would stop being an error and tsc would
      // fail this file.
      // @ts-expect-error draftAgent is intentionally NOT in PhaseAgentName (b-33)
      const _draftAgent: PhaseAgentName = 'draftAgent';
      void _draftAgent;

      // Runtime sanity: the exhaustive list above is exactly the four agents.
      expect(expectedPhaseAgents).toHaveLength(4);
      expect(expectedPhaseAgents).not.toContain('draftAgent' as unknown as PhaseAgentName);
    });

    it('compiled graph does not register a draftAgent node', () => {
      // The compiled StateGraph exposes its node map. If a draftAgent node
      // had survived the collapse it would appear here. We assert the
      // four per-phase agents are present and draftAgent is absent.
      const graph = createAgentGraph();
      // LangGraph compiled graphs expose `nodes` (Map-like). We don't depend
      // on a particular shape — `Object.keys` works for both Map and plain
      // object shapes via a small union.
      const nodes = (graph as unknown as { nodes?: Record<string, unknown> | Map<string, unknown> }).nodes;
      const nodeNames = nodes
        ? nodes instanceof Map
          ? Array.from(nodes.keys())
          : Object.keys(nodes)
        : [];

      // If we got node names at all, draftAgent must NOT be one of them and
      // the four per-phase nodes must be.
      if (nodeNames.length > 0) {
        expect(nodeNames).not.toContain('draftAgent');
        expect(nodeNames).toContain('planAgent');
        expect(nodeNames).toContain('buildAgent');
        expect(nodeNames).toContain('verifyAgent');
        expect(nodeNames).toContain('doneAgent');
      }
    });
  });

  it('routes through the buildAgent → tools → buildAgent cycle when specPhase=build', async () => {
    const toolUseContent: ContentBlock[] = [
      // create_task is entity-acting on the spec — single `ref` per T-6.
      { type: 'tool_use', id: 'b-1', name: 'create_task', input: { ref: 'ns/mx/specs/spec-1', title: 'X' } },
    ];
    const finalContent: ContentBlock[] = [{ type: 'text', text: 'Task created.' }];

    let callCount = 0;
    vi.mocked(callLlmProxy).mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? fakeStream([
            { type: 'message_complete', content: toolUseContent, stopReason: 'tool_use' },
          ])
        : fakeStream([
            { type: 'message_complete', content: finalContent, stopReason: 'end_turn' },
          ]);
    });
    vi.mocked(executeToolRemote).mockResolvedValue('Task created (t-1).');

    const graph = createAgentGraph();
    const result = await graph.invoke(
      {
        messages: [{ role: 'user', content: 'Add a task' }],
        docId: 'doc-1',
        specPhase: 'build',
      },
      { configurable: { thread_id: 'build-loop', callbacks: {} } }
    );

    // Mutation tool ran (build allows mutations) and the loop completed.
    expect(executeToolRemote).toHaveBeenCalledWith(
      'create_task',
      { ref: 'ns/mx/specs/spec-1', title: 'X' },
      undefined,
      'doc-1',
      // spec-143 t-4 (dec-6): toolsNode forwards the agent mode; undefined in
      // the default (non-drift) spec flow.
      undefined
    );
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3]).toEqual({ role: 'assistant', content: finalContent });
  });

  it('doneAgent rejects mutation tools but still answers via the LLM', async () => {
    // Agent calls a mutation tool while the doc is in `done`. The
    // doneToolsNode synthesises an error tool_result without hitting the
    // server tool executor, then loops back to doneAgent which responds.
    const mutationContent: ContentBlock[] = [
      {
        type: 'tool_use',
        id: 'mut-1',
        name: 'update_section',
        input: { ref: 'ns/mx/specs/spec-1/sections/s-1', content: 'New' },
      },
    ];
    const followUpContent: ContentBlock[] = [
      { type: 'text', text: 'Cannot edit a closed Spec.' },
    ];

    let callCount = 0;
    vi.mocked(callLlmProxy).mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? fakeStream([
            { type: 'message_complete', content: mutationContent, stopReason: 'tool_use' },
          ])
        : fakeStream([
            { type: 'message_complete', content: followUpContent, stopReason: 'end_turn' },
          ]);
    });

    const callbacks: AgentCallbacks = {
      onToolStart: vi.fn(),
      onToolResult: vi.fn(),
    };

    const graph = createAgentGraph();
    const result = await graph.invoke(
      {
        messages: [{ role: 'user', content: 'Edit the overview' }],
        docId: 'doc-1',
        specPhase: 'done',
      },
      { configurable: { thread_id: 'done-mut', callbacks } }
    );

    // The mutation tool was NEVER executed server-side.
    expect(executeToolRemote).not.toHaveBeenCalled();
    expect(callbacks.onToolStart).not.toHaveBeenCalled();

    // The synthesised tool_result is an error and tells the agent why.
    const toolResultMsg = result.messages[2];
    const toolResultBlock = (toolResultMsg.content as ContentBlock[])[0];
    expect(toolResultBlock.type).toBe('tool_result');
    expect((toolResultBlock as any).is_error).toBe(true);
    expect((toolResultBlock as any).content).toMatch(/not allowed/);
    expect((toolResultBlock as any).content).toMatch(/done/);

    // The agent saw the rejection and produced a follow-up message.
    expect(result.messages[3]).toEqual({ role: 'assistant', content: followUpContent });
  });

  it('doneAgent allows non-mutation (read-only) tools through to the executor', async () => {
    // Read-only tools (list_*, get_*, search_*, find_*, code_*) don't match
    // the mutation pattern and should still execute normally in the done
    // phase so the agent can answer questions about the closed Spec.
    const readContent: ContentBlock[] = [
      // list_comments is entity-acting on the doc — single `ref` per T-6.
      { type: 'tool_use', id: 'r-1', name: 'list_comments', input: { ref: 'ns/mx/specs/spec-1' } },
    ];
    const followUpContent: ContentBlock[] = [
      { type: 'text', text: 'Here are the comments.' },
    ];

    let callCount = 0;
    vi.mocked(callLlmProxy).mockImplementation(() => {
      callCount++;
      return callCount === 1
        ? fakeStream([
            { type: 'message_complete', content: readContent, stopReason: 'tool_use' },
          ])
        : fakeStream([
            { type: 'message_complete', content: followUpContent, stopReason: 'end_turn' },
          ]);
    });
    vi.mocked(executeToolRemote).mockResolvedValue('No comments.');

    const graph = createAgentGraph();
    const result = await graph.invoke(
      {
        messages: [{ role: 'user', content: 'Show comments' }],
        docId: 'doc-1',
        specPhase: 'done',
      },
      { configurable: { thread_id: 'done-read', callbacks: {} } }
    );

    expect(executeToolRemote).toHaveBeenCalledWith(
      'list_comments',
      { ref: 'ns/mx/specs/spec-1' },
      undefined,
      'doc-1'
    );
    expect(result.messages[3]).toEqual({ role: 'assistant', content: followUpContent });
  });

  it('graph topology: createAgentGraph compiles without throwing', () => {
    // Smoke test for the wiring — ensures all 4 per-phase nodes are
    // registered and every conditional edge resolves to a valid node. If
    // any addNode / addConditionalEdges target is wrong, compile() throws.
    expect(() => createAgentGraph()).not.toThrow();
  });

  // ──────────────────────────────────────────────
  // spec-143: the drift agent mode — same agent surface, drift posture,
  // confirmation-gated mutations.
  // ──────────────────────────────────────────────
  describe('drift agent mode (spec-143)', () => {
    const SPEC143 = 'mindset-prod/memex-building-itself/specs/spec-143';
    // ac-3 (scope, linked to dec-6): the drift agent runs on the SAME surface
    // as the Spec agent — the LangGraph graph + agentNode + render_confirmation
    // — selected by agentMode, not a separate implementation.
    const AC_DRIFT_SURFACE = `${SPEC143}/acs/ac-3`;
    // ac-5 (scope, linked to dec-6): every drift mutation passes through the
    // render_confirmation gate (the tool-scoping half is verified server-side
    // in tools.drift-mode.test.ts).
    const AC_GATED_RESOLUTION = `${SPEC143}/acs/ac-5`;
    // ac-11 (implementation, dec-3/dec-4): accept/reject/resolve execute only
    // after a 'confirmed' response; 'cancelled' performs no mutation.
    const AC_CONFIRM_GATE = `${SPEC143}/acs/ac-11`;

    it('drift mode reuses the agent surface: routes to an agent node and forwards mode=drift with no bound doc', async () => {
      tagAc(AC_DRIFT_SURFACE);

      // Routing: drift mode goes straight to an agent node (the generic
      // agentNode via planAgent), never the createDoc path, despite docId null.
      expect(
        routeByPhase({ messages: [], docId: null, specPhase: null, agentMode: 'drift' })
      ).toBe('planAgent');

      const textContent: ContentBlock[] = [
        { type: 'text', text: 'Two open drift items on std-9.' },
      ];
      vi.mocked(callLlmProxy).mockReturnValue(
        fakeStream([
          { type: 'message_complete', content: textContent, stopReason: 'end_turn' },
        ])
      );

      const graph = createAgentGraph();
      const result = await graph.invoke(
        {
          messages: [{ role: 'user', content: 'Summarize the open drift' }],
          agentMode: 'drift',
        },
        { configurable: { thread_id: 'drift-surface-1' } }
      );

      expect(result.messages).toHaveLength(2);
      // The same callLlmProxy the Spec agent uses, with the drift posture
      // selected server-side by mode — no docId (drift is memex-scoped).
      expect(callLlmProxy).toHaveBeenCalledWith(
        { docId: undefined, messages: expect.any(Array), mode: 'drift' },
        undefined
      );
    });

    it('render_confirmation PAUSES the graph — a sibling mutation tool_use does not execute before the user responds', async () => {
      tagAc(AC_CONFIRM_GATE);
      tagAc(AC_GATED_RESOLUTION);

      // The structural gate: shouldContinue exits the graph when an interactive
      // UI tool is present, so even if the model emits a mutation in the SAME
      // turn as the confirmation, nothing executes until the user responds.
      const turn: ContentBlock[] = [
        { type: 'text', text: 'I will resolve this drift finding.' },
        {
          type: 'tool_use',
          id: 'confirm-1',
          name: 'render_confirmation',
          input: { message: "Resolve drift c-3 on std-9 as 'resolved'?" },
        },
        {
          type: 'tool_use',
          id: 'mut-1',
          name: 'update_comment',
          input: { ref: 'ns/mx/standards/std-9/comments/c-3', status: 'resolved', resolution: 'resolved' },
        },
      ];
      vi.mocked(callLlmProxy).mockReturnValue(
        fakeStream([{ type: 'message_complete', content: turn, stopReason: 'tool_use' }])
      );

      const graph = createAgentGraph();
      await graph.invoke(
        {
          messages: [{ role: 'user', content: 'Resolve this drift item' }],
          agentMode: 'drift',
        },
        { configurable: { thread_id: 'drift-gate-1' } }
      );

      // No mutation ran; the graph stopped at the confirmation.
      expect(executeToolRemote).not.toHaveBeenCalled();
      expect(callLlmProxy).toHaveBeenCalledTimes(1);
    });

    it("a 'confirmed' response lets the agent execute the resolution on the drift tool surface", async () => {
      tagAc(AC_CONFIRM_GATE);
      tagAc(AC_GATED_RESOLUTION);

      // Resume the conversation after the user clicked Confirm: the model now
      // issues the gated mutation, and toolsNode executes it with mode 'drift'
      // (memex-scoped, no bound doc).
      const history: MessageParam[] = [
        { role: 'user', content: 'Resolve this drift item' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "Resolve drift c-3 on std-9 as 'resolved'?" },
            {
              type: 'tool_use',
              id: 'confirm-1',
              name: 'render_confirmation',
              input: { message: "Resolve drift c-3 on std-9 as 'resolved'?" },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'confirm-1', content: 'confirmed' },
          ],
        },
      ];

      const mutationTurn: ContentBlock[] = [
        {
          type: 'tool_use',
          id: 'mut-1',
          name: 'update_comment',
          input: { ref: 'ns/mx/standards/std-9/comments/c-3', status: 'resolved', resolution: 'resolved' },
        },
      ];
      const doneTurn: ContentBlock[] = [
        { type: 'text', text: 'Resolved c-3 with resolution=resolved.' },
      ];

      let llmCall = 0;
      vi.mocked(callLlmProxy).mockImplementation(() => {
        llmCall++;
        return llmCall === 1
          ? fakeStream([{ type: 'message_complete', content: mutationTurn, stopReason: 'tool_use' }])
          : fakeStream([{ type: 'message_complete', content: doneTurn, stopReason: 'end_turn' }]);
      });
      vi.mocked(executeToolRemote).mockResolvedValue(
        'Comment c-3 resolved (resolution=resolved).'
      );

      const graph = createAgentGraph();
      await graph.invoke(
        { messages: history, agentMode: 'drift' },
        { configurable: { thread_id: 'drift-confirmed-1' } }
      );

      // The mutation ran ONLY after the confirmed tool_result, on the drift
      // surface (mode 'drift', no bound doc), stamping the distinct resolution.
      expect(executeToolRemote).toHaveBeenCalledTimes(1);
      expect(executeToolRemote).toHaveBeenCalledWith(
        'update_comment',
        expect.objectContaining({ resolution: 'resolved' }),
        undefined,
        undefined,
        'drift'
      );
    });

    it("a 'cancelled' response performs NO mutation", async () => {
      tagAc(AC_CONFIRM_GATE);

      // Resume after the user clicked Cancel: the model acknowledges in text;
      // nothing executes — the cancel path triggers zero server-tool calls.
      const history: MessageParam[] = [
        { role: 'user', content: 'Resolve this drift item' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "Resolve drift c-3 on std-9 as 'resolved'?" },
            {
              type: 'tool_use',
              id: 'confirm-1',
              name: 'render_confirmation',
              input: { message: "Resolve drift c-3 on std-9 as 'resolved'?" },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'confirm-1', content: 'cancelled' },
          ],
        },
      ];

      vi.mocked(callLlmProxy).mockReturnValue(
        fakeStream([
          {
            type: 'message_complete',
            content: [{ type: 'text', text: 'Okay — leaving c-3 open.' }],
            stopReason: 'end_turn',
          },
        ])
      );

      const graph = createAgentGraph();
      const result = await graph.invoke(
        { messages: history, agentMode: 'drift' },
        { configurable: { thread_id: 'drift-cancelled-1' } }
      );

      expect(executeToolRemote).not.toHaveBeenCalled();
      // One follow-up assistant turn, no tool loop.
      expect(callLlmProxy).toHaveBeenCalledTimes(1);
      expect(result.messages[result.messages.length - 1].role).toBe('assistant');
    });
  });
});
