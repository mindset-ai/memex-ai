// Unit tests for clientLabel — the channel→human-label mapping shared by the
// Pulse page and ActivityRow (dec-7). UNTAGGED pure-function checks.

import { describe, it, expect } from 'vitest';
import { clientLabel } from './clientLabel';

describe('clientLabel', () => {
  it('maps the known channels to their display labels', () => {
    expect(clientLabel('server', 'whatever')).toBe('System');
    expect(clientLabel('in_app_agent', 'whatever')).toBe('In-app agent');
    expect(clientLabel('rest_ui', 'whatever')).toBe('This browser');
  });

  it('shows a short clientId prefix for the mcp channel', () => {
    expect(clientLabel('mcp', 'abcdef0123456789')).toBe('MCP · abcdef');
  });

  it('falls back to a generic Client label for unknown/undefined channels', () => {
    expect(clientLabel(undefined, 'zyxwvu98765')).toBe('Client · zyxwvu');
  });

  it('does not pad when the clientId is shorter than the slice', () => {
    expect(clientLabel('mcp', 'ab')).toBe('MCP · ab');
    expect(clientLabel(undefined, '')).toBe('Client · ');
  });
});
