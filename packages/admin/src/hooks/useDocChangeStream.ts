import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../components/AuthContext';
import { tenantBase, BASE_URL } from '../api/http';

/**
 * Subscribes to real-time document change events via SSE.
 * When docId is provided, listens for changes to that specific document.
 * When docId is null, listens for all document changes (useful for doc list).
 *
 * Calls onEvent whenever a change is detected (from any source: agent, MCP, REST).
 * Automatically reconnects with exponential backoff on connection loss.
 * Debounces rapid events (200ms) to avoid redundant refetches.
 *
 * Connection sharing (spec-118 fix): a single Spec page mounts this hook from
 * several components at once (DocDocument, useDocRole, SpecRoleControls,
 * IssuePanel, …), all on the SAME stream scope. Previously each call opened its
 * OWN long-lived streaming `fetch`. Under HTTP/1.1 (local dev via the Vite
 * proxy) the browser caps concurrent connections per origin at 6, so a handful
 * of these never-closing streams SATURATED the pool and starved every other
 * request — mutations (promote/assign POSTs) and refetches alike STALLED with no
 * error, so the role/assignment controls "did nothing". The fix multiplexes all
 * subscribers on the same `(url, token)` scope onto ONE shared connection, so a
 * Spec page holds one stream instead of four. This is the spec-16 "one reactive
 * channel" intent expressed at the transport layer.
 */

// ── Shared SSE connection registry ──────────────────────────────────────────
// Keyed by `${url}::${token}` so every subscriber on the same stream scope
// shares one underlying streaming fetch. Ref-counted: the connection opens with
// the first subscriber and aborts when the last one leaves.

type Subscriber = () => void;

interface SharedConn {
  subscribers: Set<Subscriber>;
  abort: AbortController;
  closed: boolean;
}

const connections = new Map<string, SharedConn>();

function notify(conn: SharedConn): void {
  // Snapshot so a subscriber that unsubscribes during dispatch can't mutate the
  // set mid-iteration.
  for (const sub of Array.from(conn.subscribers)) {
    sub();
  }
}

function runConnection(key: string, url: string, headers: Record<string, string>): void {
  const conn = connections.get(key);
  if (!conn) return;

  let retryDelay = 1000;
  // doc-16 dec-4: every SSE consumer MUST refetch when the stream re-establishes,
  // even before any event arrives on the new connection — this makes "I missed
  // events during a short disconnect" invisible without a durable event log. The
  // FIRST connect does NOT fire (each consumer's own initial fetch covers that);
  // every subsequent reconnect notifies all current subscribers.
  let hasConnectedBefore = false;

  async function connect(): Promise<void> {
    try {
      const res = await fetch(url, { headers, signal: conn!.abort.signal });
      if (!res.ok) throw new Error(`SSE connection failed: ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      retryDelay = 1000; // Reset on successful connection

      if (hasConnectedBefore) notify(conn!);
      hasConnectedBefore = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.trim()) continue;
          let eventType = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim();
          }
          if (eventType === 'doc_change' && !conn!.closed) notify(conn!);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }

    // Reconnect with exponential backoff while subscribers remain.
    if (!conn!.closed) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 30_000);
      if (!conn!.closed) connect();
    }
  }

  connect();
}

function acquire(
  key: string,
  url: string,
  headers: Record<string, string>,
  sub: Subscriber,
): void {
  let conn = connections.get(key);
  if (!conn) {
    conn = { subscribers: new Set(), abort: new AbortController(), closed: false };
    connections.set(key, conn);
    conn.subscribers.add(sub);
    runConnection(key, url, headers);
    return;
  }
  conn.subscribers.add(sub);
}

function release(key: string, sub: Subscriber): void {
  const conn = connections.get(key);
  if (!conn) return;
  conn.subscribers.delete(sub);
  if (conn.subscribers.size === 0) {
    conn.closed = true;
    conn.abort.abort();
    connections.delete(key);
  }
}

export function useDocChangeStream(docId: string | null, onEvent: () => void) {
  const { token } = useAuth();
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedCallback = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onEventRef.current();
    }, 200);
  }, []);

  useEffect(() => {
    if (!docId && docId !== null) return;

    // t-18 of doc-15 (F.3): doc-events live under the tenancy-scoped path prefix.
    // tenantBase() returns null on the bare/apex domain — fall back to the flat
    // surface, which still works for single-membership callers via std-5.
    const base = tenantBase() ?? BASE_URL;
    // Pulse (b-60) t-11: `include=mutations` is the server default; stated
    // explicitly so the action contract is visible at the call site.
    const url = docId
      ? `${base}/docs/events/${docId}?include=mutations`
      : `${base}/docs/events?include=mutations`;

    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const key = `${url}::${token ?? ''}`;
    acquire(key, url, headers, debouncedCallback);

    return () => {
      release(key, debouncedCallback);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [docId, token, debouncedCallback]);
}
