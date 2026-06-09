// spec-200 t-5: client for the global What's New feed.
//
// GET /api/whats-new — one global feed (dec-3), newest-first, auth auto-attached
// by fetchWithRetry. Pure read; generation happens server-side at deploy (t-3).

import { fetchJson as fetchJsonRaw } from './fetchJson';
import { BASE_URL, fetchWithRetry } from './http';

export interface WhatsNewEntry {
  id: string;
  sourceSpecRef: string;
  sourceSpecHandle: string;
  title: string;
  what: string;
  why: string;
  publishedAt: string;
}

export async function fetchWhatsNew(): Promise<WhatsNewEntry[]> {
  const { entries } = await fetchJsonRaw<{ entries: WhatsNewEntry[] }>(
    fetchWithRetry,
    `${BASE_URL}/whats-new`,
  );
  return entries;
}
