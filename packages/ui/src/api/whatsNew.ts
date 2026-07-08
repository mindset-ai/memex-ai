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

export interface WhatsNewResponse {
  entries: WhatsNewEntry[];
  /** spec-439: the requesting user's createdAt — absent on old server versions. */
  suppressBefore: string | undefined;
}

export async function fetchWhatsNew(): Promise<WhatsNewResponse> {
  const data = await fetchJsonRaw<{ entries: WhatsNewEntry[]; suppressBefore?: string }>(
    fetchWithRetry,
    `${BASE_URL}/whats-new`,
  );
  return { entries: data.entries, suppressBefore: data.suppressBefore };
}
