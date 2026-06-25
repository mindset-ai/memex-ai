// clientLabel — the human-readable label for an originating CLIENT (the surface
// an action arrived through), keyed by channel (dec-7). Shared by the Pulse page
// (active-client chips) and ActivityRow (the actor's surface). Never the raw
// clientId (an opaque session hash / MCP token id / conversation id) — that's
// the filter key, not display text.

import type { ActivityChannel } from './types';

export function clientLabel(
  channel: ActivityChannel | undefined,
  clientId: string,
): string {
  switch (channel) {
    case 'server':
      return 'System';
    case 'in_app_agent':
      return 'In-app agent';
    case 'mcp':
      // The MCP token's name isn't surfaced client-side yet (Wave-3 follow-up);
      // fall back to a short, readable prefix rather than the full token id.
      return `MCP · ${clientId.slice(0, 6)}`;
    case 'rest_ui':
      return 'This browser';
    default:
      return `Client · ${clientId.slice(0, 6)}`;
  }
}
