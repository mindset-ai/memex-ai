import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchDocs } from '../../api/docs';
import type { DocSummary } from '../../api/types';

/**
 * spec-529 t-3 — the page-level status set every reference pill reads from.
 *
 * Without this layer a document mentioning thirty Specs issues thirty requests,
 * which is the failure the whole design is arranged to avoid. Pills do not
 * fetch; they register a handle and read the answer. Opening a card fetches
 * nothing at all, because the card renders from the same resolved entry.
 *
 * Registrations are collected and flushed ONCE per tick, so every pill mounted
 * in the same commit — which is every pill in a rendered document — resolves in
 * a single request. A handle that appears later (a lazily-rendered section, a
 * newly-posted comment) starts a second batch containing only what is new;
 * nothing already known is ever re-requested.
 *
 * A missing provider is a supported state, not a bug: `useSpecRefStatus` simply
 * never resolves, and the pill degrades to the plain handle. That is what keeps
 * a markdown surface which has not opted in from breaking.
 */

/** What we know about one handle. `missing` covers BOTH "no such Spec" and "not
 *  yours to see" — the server answers them identically [per std-7], and so does
 *  the renderer. */
export type SpecRefEntry =
  | { state: 'pending' }
  | { state: 'resolved'; doc: DocSummary }
  | { state: 'missing' };

interface SpecRefContextValue {
  entries: ReadonlyMap<string, SpecRefEntry>;
  register: (handle: string) => void;
}

const SpecRefContext = createContext<SpecRefContextValue | null>(null);

/** The server projections a pill and its card need, asked for once. */
const INCLUDE = ['taskProgress', 'acHealth', 'lastActivity'] as const;

export function SpecRefStatusProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ReadonlyMap<string, SpecRefEntry>>(
    () => new Map(),
  );
  // Handles seen this session — the dedupe guard. Held in a ref rather than
  // state because registering must never itself cause a render.
  const seen = useRef<Set<string>>(new Set());
  const queue = useRef<Set<string>>(new Set());
  const flushScheduled = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const flush = useCallback(async () => {
    flushScheduled.current = false;
    const batch = [...queue.current];
    queue.current.clear();
    if (batch.length === 0) return;

    try {
      const docs = await fetchDocs('spec', { handles: batch, include: INCLUDE });
      if (!alive.current) return;
      const byHandle = new Map(docs.map((d) => [d.handle, d]));
      setEntries((prev) => {
        const next = new Map(prev);
        for (const handle of batch) {
          const doc = byHandle.get(handle);
          next.set(handle, doc ? { state: 'resolved', doc } : { state: 'missing' });
        }
        return next;
      });
    } catch {
      // A failed resolution degrades the whole page to plain handles rather than
      // breaking the render. The body is still readable, which is the point.
      if (!alive.current) return;
      setEntries((prev) => {
        const next = new Map(prev);
        for (const handle of batch) next.set(handle, { state: 'missing' });
        return next;
      });
    }
  }, []);

  const register = useCallback(
    (handle: string) => {
      if (seen.current.has(handle)) return;
      seen.current.add(handle);
      queue.current.add(handle);
      setEntries((prev) => {
        const next = new Map(prev);
        next.set(handle, { state: 'pending' });
        return next;
      });
      if (!flushScheduled.current) {
        flushScheduled.current = true;
        // One tick's worth of registrations become one request.
        queueMicrotask(() => void flush());
      }
    },
    [flush],
  );

  const value = useMemo<SpecRefContextValue>(
    () => ({ entries, register }),
    [entries, register],
  );

  return <SpecRefContext.Provider value={value}>{children}</SpecRefContext.Provider>;
}

/**
 * Registers a handle with the page's status set and returns what is known about
 * it. Returns `undefined` when there is no provider above — the un-opted-in
 * surface, where the pill must stay plain text.
 */
export function useSpecRefStatus(handle: string): SpecRefEntry | undefined {
  const ctx = useContext(SpecRefContext);
  useEffect(() => {
    ctx?.register(handle);
  }, [ctx, handle]);
  return ctx?.entries.get(handle);
}

/** Test seam: true when a provider is above this point in the tree. */
export function useHasSpecRefProvider(): boolean {
  return useContext(SpecRefContext) !== null;
}
