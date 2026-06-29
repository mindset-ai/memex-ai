// spec-304 t-60 (dec-24): per-client "MCP status notification" preference — does
// a given pill-driving (local/token) client drive the native chrome pill?
//
// Default ON. Switching it OFF for a client means that client never drives the
// pill (its inline row status still shows). The classic case: a user who never
// uses Claude Code switches it off and is no longer nagged to install it.
//
// A tiny module-level store (localStorage-backed, with subscribe) rather than
// React state, on purpose: the pill is driven from TWO hook instances — the
// app-global <DesktopMcpStatusSync/> and the Settings <DesktopMcpSection/> — and
// they must agree on what drives the pill, or they'd fight (one pushing "hide",
// the other re-pushing "install"). A single shared source of truth keeps every
// reader consistent, and persists per-device (the pill is a per-machine concern).

const STORAGE_PREFIX = 'memex.mcpPillNotify.';
const listeners = new Set<() => void>();

function key(client: string): string {
  return `${STORAGE_PREFIX}${client}`;
}

/** Whether [client] drives the native pill. Default true (absent / unreadable). */
export function isPillNotificationEnabled(client: string): boolean {
  try {
    return localStorage.getItem(key(client)) !== 'false';
  } catch {
    return true;
  }
}

/** Set [client]'s pill preference and notify every subscriber (both hooks). */
export function setPillNotificationEnabled(client: string, enabled: boolean): void {
  try {
    localStorage.setItem(key(client), enabled ? 'true' : 'false');
  } catch {
    // A storage failure must not break the toggle interaction; the in-memory
    // notify below still refreshes the current session.
  }
  for (const l of listeners) l();
}

/** Subscribe to preference changes (returns an unsubscribe). */
export function subscribePillPrefs(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
