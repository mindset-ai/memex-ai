import { describe, it, expect } from 'vitest';
import { getPendingUiTools } from './useAgentGraph';
import type { MessageParam } from './types';

describe('getPendingUiTools', () => {
  it('returns empty array for empty messages', () => {
    expect(getPendingUiTools([])).toEqual([]);
  });

  it('returns empty array when last message is a user message', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hello' },
    ];
    expect(getPendingUiTools(messages)).toEqual([]);
  });

  it('returns UI tool blocks from last assistant message', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do something' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure' },
          { type: 'tool_use', id: 'ui-1', name: 'render_confirmation', input: { message: 'OK?' } },
        ],
      },
    ];

    const result = getPendingUiTools(messages);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('render_confirmation');
    expect(result[0].id).toBe('ui-1');
  });

  it('filters out server tools and returns only UI tools', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do both' },
      {
        role: 'assistant',
        content: [
          // Server tool inputs are opaque to the UI; we just check name routing.
          { type: 'tool_use', id: 'srv-1', name: 'update_section', input: { ref: 'ns/mx/specs/spec-1/sections/s-1', content: '' } },
          { type: 'tool_use', id: 'ui-1', name: 'render_action_buttons', input: { buttons: [] } },
          { type: 'tool_use', id: 'srv-2', name: 'create_doc', input: { memex: 'ns/mx', title: '', sections: [] } },
          { type: 'tool_use', id: 'ui-2', name: 'render_choices', input: { options: [] } },
        ],
      },
    ];

    const result = getPendingUiTools(messages);
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.name)).toEqual(['render_action_buttons', 'render_choices']);
  });
});
