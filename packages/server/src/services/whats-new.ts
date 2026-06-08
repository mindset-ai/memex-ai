// spec-200 t-1: storage repo for the "What's New" release-note feed.
//
// One GLOBAL, append-only feed (dec-3): no memex/user scoping. Entries are
// generated at the daily prod promotion by the t-2 generation service and read
// by the t-4 feed API. This module is pure storage — no LLM, no bus emit (the
// feed is a deploy-time global write, mirroring the guide-content importer; it
// is NOT a Mutated<T> tenant mutation, so it deliberately stays off the std-8
// mutate()/bus path).

import { desc, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { whatsNewEntries, type WhatsNewEntry } from "../db/schema.js";

/** The fields the generation service supplies for a new entry. */
export interface NewWhatsNewEntry {
  sourceSpecRef: string;
  sourceSpecHandle: string;
  title: string;
  whatText: string;
  whyText: string;
}

/**
 * Publish an entry to the feed, idempotently (ac-6 / ac-9).
 *
 * `sourceSpecRef` is unique, so re-running a promotion that re-encounters an
 * already-published Spec is a no-op: the row is neither duplicated nor rewritten
 * (entries are stable/citable once published). Returns the inserted row, or
 * `null` when the Spec already had an entry.
 */
export async function publishEntry(entry: NewWhatsNewEntry): Promise<WhatsNewEntry | null> {
  const rows = await db
    .insert(whatsNewEntries)
    .values(entry)
    .onConflictDoNothing({ target: whatsNewEntries.sourceSpecRef })
    .returning();
  return rows[0] ?? null;
}

/**
 * The global feed, newest-first (ac-10 / ac-11 ordering). Pure stored read —
 * no LLM call on this path (ac-8 read side).
 */
export async function listEntries(limit = 50): Promise<WhatsNewEntry[]> {
  return db
    .select()
    .from(whatsNewEntries)
    .orderBy(desc(whatsNewEntries.publishedAt))
    .limit(limit);
}

/** Lookup by source Spec ref — used by the generation service to skip already-published Specs. */
export async function getEntryBySpecRef(sourceSpecRef: string): Promise<WhatsNewEntry | null> {
  const rows = await db
    .select()
    .from(whatsNewEntries)
    .where(eq(whatsNewEntries.sourceSpecRef, sourceSpecRef))
    .limit(1);
  return rows[0] ?? null;
}
