// spec-315 t-5 — "Where you're needed": the comments pulling the user in, across every
// Memex they belong to. Consumes spec-320's read contract (dec-1):
//   mentions-me        = listCommentsMentioningUser(memexId, me)
//   assigned-to-me/open = listOpenAssignmentsForUser(memexId, me)
// Union, deduped by comment, with an ASSIGNMENT ranked above a bare MENTION (a comment
// that both mentions and is assigned to me is the stronger "assignment" — the
// assignee ⊆ mentions invariant means assigned comments always also appear in mentions).
//
// CROSS-MEMEX + UNCAPPED (dec-3): Home is one user-level surface, so this spans every
// Memex the user is a member of, and never hides an open ask. Same membership-iteration
// + per-Memex RLS posture as specs-in-flight (t-1); tenancy is structural.

import { inArray } from "drizzle-orm";
import { db, runWithMemexId } from "../db/connection.js";
import { documents, type DocComment } from "../db/schema.js";
import { listMemberships } from "./users.js";
import {
  listCommentsMentioningUser,
  listOpenAssignmentsForUser,
} from "./comment-mentions.js";

// spec-353 (perf-2) — bounded fan-out concurrency, mirrors home-specs.ts. Each
// per-Memex block runs in its own runWithMemexId ALS subtree, so racing them
// keeps each tenant's app.memex_id GUC isolated (std-36). Bounded to stay inside
// the postgres-js pool (DB_POOL_MAX, default 5).
const MEMEX_CONCURRENCY = 4;

export interface WhereNeededItem {
  commentId: string;
  kind: "assignment" | "mention";
  /** The comment body (truncated in the UI). */
  snippet: string;
  specTitle: string;
  specHandle: string;
  /** Owning Memex — for the provenance pill and click-through routing. */
  memexId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
  /** Deep-link to the spec with the comment scrolled-to + highlighted (`?comment=c-<seq>`,
   *  the param DocDocument.tsx already honours — dec-4). */
  path: string;
  /** Recency of the ask: assignedAt for assignments, the comment's createdAt for mentions. */
  at: string;
}

interface MemexProvenance {
  namespaceSlug: string;
  memexSlug: string;
  memexName: string;
}

export async function listWhereYoureNeededForUser(userId: string): Promise<WhereNeededItem[]> {
  const provByMemex = new Map<string, MemexProvenance>();
  for (const m of await listMemberships(userId)) {
    // Read-only rows (visited pins, spec-111; featured "Explore" memexes,
    // spec-500) are public browsing, NOT the user's membership work — skip them.
    if (m.accessLevel === "read") continue;
    if (!provByMemex.has(m.memexId)) {
      provByMemex.set(m.memexId, {
        namespaceSlug: m.slug,
        memexSlug: m.memexSlug,
        memexName: m.memexName,
      });
    }
  }

  const assignments: WhereNeededItem[] = [];
  const mentions: WhereNeededItem[] = [];

  // The per-Memex block, RLS-scoped to one tenant. Lifted out so the cross-Memex
  // fan-out can run these in bounded-parallel batches (spec-353). Body unchanged.
  const loadMemex = (memexId: string, prov: MemexProvenance): Promise<void> =>
    runWithMemexId(memexId, async () => {
      const [mentioned, assigned] = await Promise.all([
        listCommentsMentioningUser(memexId, userId),
        listOpenAssignmentsForUser(memexId, userId),
      ]);
      if (mentioned.length === 0 && assigned.length === 0) return;

      const assignedIds = new Set(assigned.map((c) => c.id));
      const docIds = [...new Set([...mentioned, ...assigned].map((c) => c.docId))];
      const docs = docIds.length
        ? await db
            .select({ id: documents.id, handle: documents.handle, title: documents.title })
            .from(documents)
            .where(inArray(documents.id, docIds))
        : [];
      const docById = new Map(docs.map((d) => [d.id, d]));

      const toItem = (c: DocComment, kind: "assignment" | "mention"): WhereNeededItem | null => {
        const doc = docById.get(c.docId);
        if (!doc) return null;
        const when = (kind === "assignment" ? c.assignedAt : c.createdAt) ?? c.createdAt;
        return {
          commentId: c.id,
          kind,
          snippet: c.content,
          specTitle: doc.title,
          specHandle: doc.handle,
          memexId,
          namespaceSlug: prov.namespaceSlug,
          memexSlug: prov.memexSlug,
          memexName: prov.memexName,
          path: `/${prov.namespaceSlug}/${prov.memexSlug}/specs/${doc.handle}?comment=c-${c.seq}`,
          at: (when instanceof Date ? when : new Date(when)).toISOString(),
        };
      };

      for (const c of assigned) {
        const it = toItem(c, "assignment");
        if (it) assignments.push(it);
      }
      // Dedupe: a comment assigned to me is NOT also listed as a bare mention.
      for (const c of mentioned) {
        if (assignedIds.has(c.id)) continue;
        const it = toItem(c, "mention");
        if (it) mentions.push(it);
      }
    });

  // Bounded-parallel fan-out across the user's Memexes (spec-353). Each block
  // runs in its own RLS subtree; the shared assignments/mentions arrays are
  // re-sorted deterministically below, so batch interleaving can't change output.
  const entries = [...provByMemex.entries()];
  for (let i = 0; i < entries.length; i += MEMEX_CONCURRENCY) {
    const batch = entries.slice(i, i + MEMEX_CONCURRENCY);
    await Promise.all(batch.map(([memexId, prov]) => loadMemex(memexId, prov)));
  }

  // Assignments first (newest first), then mentions (newest first). ISO strings sort
  // lexically == chronologically.
  assignments.sort((a, b) => b.at.localeCompare(a.at));
  mentions.sort((a, b) => b.at.localeCompare(a.at));
  return [...assignments, ...mentions];
}
