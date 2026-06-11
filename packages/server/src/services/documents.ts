import { and, eq, ne, desc, count, isNull, inArray, or, exists, sql, type SQL } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, docSections, docComments, decisions, users, tags, documentTags } from "../db/schema.js";
import type { Doc, DocSection, Decision } from "../db/schema.js";
import type { DocSummary } from "../types/index.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { mutate, type ChangeKey, type Mutated, type RequestCtx } from "./mutate.js";
import { resolveActorColumns } from "./actor.js";
import { isUuid } from "./shared/identifiers.js";
import { withSeqRetry } from "./shared/sequence.js";
import { embedAndStoreSection, embedAndStoreDecision } from "./memex-embeddings.js";
import { aggregateAcHealthForBriefs } from "./acs.js";
import { maybeAutoResolveIssuesForPromotedDoc } from "./issues.js";
import { seedCreatorAsEditor } from "./doc-members.js";
import { listAssigneesForDocs } from "./doc-assignees.js";
import type { ParsedTag } from "./tags.js";
import { HANDHOLD_PHASES } from "../db/handhold-demo.fixture.js";

// Per-account handle sequence: doc-1, doc-2, ... within an account. Avoids cross-tenant
// collisions on the (account_id, handle) unique constraint. Accepts a db OR tx client so
// move-to-another-memex can call it inside its transaction.
// Typed as `any` to paper over Drizzle's divergent `db` vs `tx` shapes — the select+where
// usage below is identical on both, and locking down the union is not worth the noise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextDocHandle(memexId: string, dbx: any = db): Promise<string> {
  const [result] = await dbx
    .select({ maxNum: sql<number>`coalesce(max(cast(substring(handle from 'doc-([0-9]+)') as integer)), 0)` })
    .from(documents)
    .where(eq(documents.memexId, memexId));
  return `doc-${(result.maxNum ?? 0) + 1}`;
}

// Per b-105: specs adopt a typed `spec-N` handle prefix so they
// read as a first-class concept in tool output and URLs ("spec-3" beats "doc-7"
// when the reader is scanning a list of work). Lowercase — matches the
// URL-surface convention of `std-N` and `doc-N`. spec-N and doc-N share the
// (memex_id, handle) unique constraint but live in independent numeric
// sequences — spec-1 and doc-1 can coexist within the same Memex. The
// historical Spec handles (`b-N` from the pre-rename era) survive only on the
// b-105 allowlist (b-10, b-26, b-65, b-105) per the 0063 migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextSpecHandle(memexId: string, dbx: any = db): Promise<string> {
  const [result] = await dbx
    .select({ maxNum: sql<number>`coalesce(max(cast(substring(handle from 'spec-([0-9]+)') as integer)), 0)` })
    .from(documents)
    .where(eq(documents.memexId, memexId));
  return `spec-${(result.maxNum ?? 0) + 1}`;
}


// Per dec-7 of doc-8: standards adopt a typed `std-N` handle prefix so they read
// as a first-class concept in tool output ("std-3 Design Standards" beats
// "doc-7"). std-N and doc-N share the (account_id, handle) unique constraint
// but live in independent numeric sequences — std-1 and doc-1 can coexist.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextStandardHandle(memexId: string, dbx: any = db): Promise<string> {
  const [result] = await dbx
    .select({ maxNum: sql<number>`coalesce(max(cast(substring(handle from 'std-([0-9]+)') as integer)), 0)` })
    .from(documents)
    .where(eq(documents.memexId, memexId));
  return `std-${(result.maxNum ?? 0) + 1}`;
}

export interface DecisionInput {
  title: string;
  context?: string;
}

export interface BodySectionInput {
  title: string;
  content: string;
}

export interface CreateDocExtras {
  /** Ordered discrete body sections, rendered between the overview and acceptance criteria. */
  bodySections?: BodySectionInput[];
  /** Definition-of-done / acceptance criteria section, appended last when present. */
  acceptanceCriteria?: string;
  /**
   * spec-178 (issue-2): mark the new doc as a Handhold demo spec on the SAME insert
   * that creates the row, so it reads is_demo=true from its first committed state.
   * Without this the seeder created the row is_demo=false and flipped the flag only
   * on a later terminal write — so an interrupted seed could leave a committed
   * is_demo=false row that reads as a REAL spec (search/agent/board-visible) and
   * survives the demo's idempotency guard + Reset. Defaults to false (real docs).
   */
  isDemo?: boolean;
}

export async function createDocDraft(
  memexId: string,
  title: string,
  purpose: string,
  docType: string = "spec",
  decisionInputs?: DecisionInput[],
  extras?: CreateDocExtras,
  createdByUserId?: string,
  // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW). Threaded onto the
  // 'document created' event so Pulse attributes the create to the human + the
  // surface (in_app_agent / mcp / rest_ui). Defaults empty for seed/system
  // callers; actorUserId falls back to createdByUserId so the human is still
  // attributed even when a caller passes only the legacy id.
  ctx: RequestCtx = {},
): Promise<Mutated<Doc & { sections: DocSection[]; decisions: Decision[] }>> {
  // Per b-105 and std-1 (canonical URL paths):
  //   - specs         → `spec-N`    via nextSpecHandle
  //   - standards     → `std-N`     via nextStandardHandle
  //   - everything else (free-form `document`, `execution_plan`, `adr`,
  //     `runbook`) → `doc-N` via nextDocHandle
  // The three sequences share the (memex_id, handle) unique constraint but
  // increment independently within a Memex.
  //
  // b-47 regression: the previous shape only branched on the spec docType vs
  // default, so the MCP `create_doc({ docType: 'standard' })` path fell
  // through to `nextDocHandle` and minted `doc-N` handles on Standards rows — leaving
  // the entity unreachable via the std-N-only validator (`assertRefNotUuid` /
  // `resolveRef`). Standards created through the dedicated React-UI flow
  // (`createStandard → nextStandardHandle`) were unaffected; MCP creates
  // route through this function and need the explicit branch.
  return mutate(
    // Attribute the create to the human (ctx.actorUserId, else the legacy
    // createdByUserId) and the surface (ctx.channel). Without this the event
    // reached the sink unattributed and Pulse's "Just me" scope dropped it.
    { ...ctx, actorUserId: ctx.actorUserId ?? createdByUserId },
    // The new doc's id isn't known until the insert returns, so use a key
    // factory that reads it off the resolved result.
    (created) => ({ memexId, docId: created.id, entity: "document", action: "created" }),
    async () => {
      // spec-187 (b-38 F-3 finally reaching documents): the handle mint is a
      // racy COALESCE(MAX(...))+1 read — two concurrent creates in the same
      // memex can both read N and both insert handle N+1, and Postgres 23505s
      // the loser on `documents_memex_id_handle_unique`. Mirror the
      // decisions/comments/acs hardening: allocator + insert inside
      // withSeqRetry, re-minting the handle on each collision.
      const doc = await withSeqRetry(
        async () => {
          const handle =
            docType === "spec"
              ? await nextSpecHandle(memexId)
              : docType === "standard"
                ? await nextStandardHandle(memexId)
                : await nextDocHandle(memexId);
          const [row] = await db
            .insert(documents)
            .values({ memexId, handle, title, docType, status: "draft", createdByUserId: createdByUserId ?? null, isDemo: extras?.isDemo ?? false })
            .returning();
          return row;
        },
        "documents_memex_id_handle_unique",
      );

      // spec-118 dec-4: the creator becomes the Spec's first editor. On the MCP
      // path createdByUserId is always the HUMAN token owner (no separate agent
      // principal), so this records the human, never the agent (ac-13/ac-14).
      // When null (service token / no bound human) it seeds nothing. Part of the
      // 'document created' event above — no separate emission.
      await seedCreatorAsEditor(memexId, doc.id, createdByUserId);

      // Spec docs get an "Overview" first section; non-Spec types keep the legacy
      // "Purpose" first section for backward compatibility with existing callers and tests.
      // Per b-105 the canonical docType is `spec` — legacy aliases are gone
      // from the type union (see types/roles.ts).
      const isSpecShape =
        docType === "spec" ||
        (extras?.bodySections && extras.bodySections.length > 0) ||
        (extras?.acceptanceCriteria && extras.acceptanceCriteria.length > 0);
      const firstSectionType = isSpecShape ? "overview" : "purpose";
      const firstSectionTitle = isSpecShape ? "Overview" : "Purpose";

      // spec-161: a standard is born with NO body section — its content arrives later as
      // clauses via add_section (clause-first authoring). Every other docType keeps its
      // first section seeded from `purpose`.
      const isStandard = docType === "standard";
      const rows: {
        docId: string;
        sectionType: string;
        title: string;
        content: string;
        seq: number;
      }[] = isStandard
        ? []
        : [
            {
              docId: doc.id,
              sectionType: firstSectionType,
              title: firstSectionTitle,
              content: purpose,
              seq: 1,
            },
          ];

      if (extras?.bodySections) {
        extras.bodySections.forEach((s, idx) => {
          rows.push({
            docId: doc.id,
            // Unique per section — the (doc_id, section_type) unique constraint rejects
            // duplicates, so body sections are numbered rather than all sharing "body".
            sectionType: `body-${idx + 1}`,
            title: s.title,
            content: s.content,
            seq: idx + 2,
          });
        });
      }

      if (extras?.acceptanceCriteria && extras.acceptanceCriteria.trim().length > 0) {
        rows.push({
          docId: doc.id,
          sectionType: "acceptance",
          title: "Acceptance criteria",
          content: extras.acceptanceCriteria,
          seq: rows.length + 1,
        });
      }

      // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW) for the section
      // and decision rows born with the doc. `doc_sections` and `decisions` each
      // carry their own actor_user_id / actor_name / channel (they're activity-
      // bearing per std-32), so the create must stamp them just like the
      // 'document created' event above — otherwise every Spec's seed sections land
      // unattributed (NULL actor, NULL channel = a silent 'server', which std-32
      // calls a visible defect) and the create drops out of Pulse's 'me' scope.
      // resolveActorColumns denormalises actor_name at write (one PK lookup when
      // the ctx didn't carry it, ac-10) and degrades a stale id to null rather
      // than breaking the insert. actorUserId falls back to the legacy
      // createdByUserId; channel falls back to an explicit 'server' for seed/
      // system callers that pass no ctx (never a silent NULL).
      const resolved = await resolveActorColumns({
        ...ctx,
        actorUserId: ctx.actorUserId ?? createdByUserId,
      });
      const bornAttribution = {
        actorUserId: resolved.actorUserId,
        actorName: resolved.actorName,
        channel: resolved.channel ?? "server",
      };

      // spec-150 (dec-2): at creation the display `position` equals the identity `seq`.
      // spec-161: a standard inserts zero sections (born sectionless).
      const insertedSections =
        rows.length > 0
          ? await db
              .insert(docSections)
              .values(rows.map((r) => ({ ...r, position: r.seq, ...bornAttribution })))
              .returning()
          : [];

      let createdDecisions: Decision[] = [];
      if (decisionInputs && decisionInputs.length > 0) {
        createdDecisions = await db
          .insert(decisions)
          .values(
            decisionInputs.map((d, i) => ({
              memexId,
              docId: doc.id,
              seq: i + 1,
              title: d.title,
              context: d.context ?? null,
              status: "open",
              ...bornAttribution,
            }))
          )
          .returning();
      }

      // Fire-and-forget embed for sections and decisions inserted here. The
      // per-mutation paths (addSection / updateSection / decision writes)
      // already do this; createDocDraft inserts directly so we mirror the
      // pattern. Without this, a freshly-created Spec is invisible to
      // search_memex's vector arm until someone edits it or a backfill runs.
      for (const s of insertedSections) {
        void embedAndStoreSection(s.id, { memexId }).catch(() => {});
      }
      for (const d of createdDecisions) {
        void embedAndStoreDecision(d.id, { memexId }).catch(() => {});
      }

      return { ...doc, sections: insertedSections, decisions: createdDecisions };
    },
  );
}

export interface ListDocsOptions {
  docType?: string;
  // Default false — archived docs are hidden from the kanban. Set true to include them
  // (e.g. a future archive view or admin tooling).
  includeArchived?: boolean;
  // Default true — paused docs ARE included (so the React UI kanban can render
  // them under a "Show paused" toggle and filter client-side). Pass false to
  // hide paused docs from the result; MCP `list_briefs` does this per doc-12
  // t-15 to keep the agent focused on active work.
  includePaused?: boolean;
  // Optional status whitelist. When provided, only docs whose `status` is in the
  // list are returned. Used by `list_briefs` (doc-12 t-15) to scope to the
  // active Spec phases (specify / build / verify) and exclude draft / done.
  statusIn?: readonly string[];
  // Per t-19 W2: when set, attach an open `commentType='drift'` count per doc so the
  // StandardList sidebar can render the drift badge in one round-trip instead of
  // fan-out fetchDocComments calls. Cheap because doc_comments.account_id is indexed
  // and we only count rows with comment_type='drift'.
  includeDriftCount?: boolean;
  // Per b-66 t-2: when set, attach an `acHealth` six-number roll-up per Spec so
  // the Specs board can render per-card AC-health treatment in one round-trip.
  // Spec docType only — non-Spec summaries leave `acHealth` unset. Specs with
  // zero active ACs ALSO leave `acHealth` unset (absence-of-signal, b-66 Scope
  // AC-4) so the UI's "no commitments" branch trips naturally.
  includeAcHealth?: boolean;
  // spec-118 ac-18: when set, attach an `assignees` array per Spec so the board
  // can render assignee avatar(s) on each card (more prominent than the creator)
  // in one round-trip. Specs with no assignees leave `assignees` unset → the card
  // renders an "Unassigned" state.
  includeAssignees?: boolean;
  // spec-178 t-11 / dec-11 (ac-37): when true, exclude is_demo docs from the
  // result. Default falsy — the REST board route (routes/documents.ts) leaves
  // this unset so the Specs board KEEPS rendering demo specs (with the DEMO
  // badge). Only the MCP/agent `list_docs` path sets excludeDemo:true so a
  // coding agent never sees a demo spec in its enumeration. Demo specs are
  // invisible/inert to all agent surfaces but visible on the board.
  excludeDemo?: boolean;
  // spec-136 t-3: narrow the result to docs carrying the given tags. Facet semantics
  // (dec-1): AND across different scopes, OR within a single scope; each flat (unscoped)
  // tag is its own AND clause. Resolved via an indexed (scope, value) join — no LIKE.
  // This is ADDITIVE to the existing docType predicate above, never a replacement: the
  // Specs view still passes its own docType, so develop's finalised 'spec' value stays
  // the single source of truth for what counts as a Spec (ac-14) — never hardcoded here.
  tags?: ParsedTag[];
}

// spec-136 t-3: append tag-filter conditions to a listDocs WHERE clause.
// Facet semantics (dec-1): OR within a single scope, AND across different scopes; each
// flat (unscoped) tag is its own AND clause. Selected (scope, value) pairs resolve to
// tag ids via ONE indexed lookup — no LIKE and no parsing of a `scope::value` literal
// (ac-9). Each resulting group becomes a correlated EXISTS over document_tags keyed by
// (memex_id, tag_id), so the bridge's indexes carry the lookup.
async function appendTagConditions(
  conditions: SQL[],
  memexId: string,
  selected: ParsedTag[],
): Promise<void> {
  const matchAny = selected.map((t) =>
    and(
      t.scope === null ? isNull(tags.scope) : eq(tags.scope, t.scope),
      eq(tags.value, t.value),
    ),
  );
  const matched = await db
    .select({ id: tags.id, scope: tags.scope, value: tags.value })
    .from(tags)
    .where(and(eq(tags.memexId, memexId), or(...matchAny)));

  // Scoped tags sharing a scope form one OR group; each flat tag is its own group.
  // A group that resolves to zero ids means the user filtered by a tag that doesn't
  // exist → that AND clause is unsatisfiable → the whole result is empty.
  const groups = new Map<string, string[]>();
  for (const t of selected) {
    const key = t.scope === null ? `flat:${t.value}` : `scope:${t.scope}`;
    const id = matched.find((m) => m.scope === t.scope && m.value === t.value)?.id;
    const ids = groups.get(key) ?? [];
    if (id) ids.push(id);
    groups.set(key, ids);
  }

  for (const ids of groups.values()) {
    if (ids.length === 0) {
      conditions.push(sql`false`);
      continue;
    }
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(documentTags)
          .where(
            and(
              eq(documentTags.docId, documents.id),
              eq(documentTags.memexId, memexId),
              inArray(documentTags.tagId, ids),
            ),
          ),
      ),
    );
  }
}

export async function listDocs(
  memexId: string,
  docTypeOrOpts?: string | ListDocsOptions,
): Promise<DocSummary[]> {
  const opts: ListDocsOptions =
    typeof docTypeOrOpts === "string" ? { docType: docTypeOrOpts } : docTypeOrOpts ?? {};
  const conditions = [eq(documents.memexId, memexId)];
  if (opts.docType) conditions.push(eq(documents.docType, opts.docType));
  if (!opts.includeArchived) conditions.push(isNull(documents.archivedAt));
  // Paused docs are included by default (React UI kanban renders them under a
  // "Show paused" toggle). MCP list_missions passes includePaused=false.
  if (opts.includePaused === false) conditions.push(isNull(documents.pausedAt));
  // spec-178 t-11 / dec-11 (ac-37): exclude demo specs from the agent/MCP
  // enumeration when asked. is_demo is NOT NULL DEFAULT false, but the
  // `isNull OR ne(true)` guard is robust against any legacy NULL while still
  // letting the board (excludeDemo falsy) keep its demo cards.
  if (opts.excludeDemo) {
    const notDemo = or(isNull(documents.isDemo), ne(documents.isDemo, true));
    if (notDemo) conditions.push(notDemo);
  }
  if (opts.statusIn && opts.statusIn.length > 0) {
    conditions.push(inArray(documents.status, opts.statusIn as string[]));
  }
  if (opts.tags && opts.tags.length > 0) {
    await appendTagConditions(conditions, memexId, opts.tags);
  }

  const rows = await db
    .select({
      id: documents.id,
      memexId: documents.memexId,
      handle: documents.handle,
      title: documents.title,
      docType: documents.docType,
      status: documents.status,
      parentDocId: documents.parentDocId,
      createdAt: documents.createdAt,
      statusChangedAt: documents.statusChangedAt,
      // doc-12 t-1 / t-13: lifecycle flags. archivedAt is already filtered out by
      // default (see conditions above); pausedAt is the new client-side filter
      // surface for the Specs kanban "Show paused" toggle.
      pausedAt: documents.pausedAt,
      archivedAt: documents.archivedAt,
      // spec-178 t-1 (ac-9): is_demo rides on every DocSummary (like pausedAt/archivedAt)
      // so the board can render the DEMO badge. Always projected — not behind an include opt.
      isDemo: documents.isDemo,
      sectionCount: count(docSections.id),
      // LEFT JOIN — null when the doc predates migration 0036 or the creator
      // has been deleted (FK is ON DELETE SET NULL). The React UI renders
      // "Unknown" in that case.
      creatorName: users.name,
      creatorEmail: users.email,
    })
    .from(documents)
    .leftJoin(docSections, eq(documents.id, docSections.docId))
    .leftJoin(users, eq(documents.createdByUserId, users.id))
    .where(and(...conditions))
    .groupBy(documents.id, users.id)
    .orderBy(desc(documents.createdAt));

  const summaries: DocSummary[] = rows.map((row) => {
    const { creatorName, creatorEmail, ...rest } = row;
    return {
      ...rest,
      sectionCount: Number(row.sectionCount),
      creator: creatorName || creatorEmail
        ? { name: creatorName, email: creatorEmail }
        : null,
    };
  });

  // t-20 W-F: minimal parent projection so the Specs list card can render
  // "Promoted from <title> (<docType>)" even when the parent isn't a Spec
  // (and so isn't in the same listDocs result). One extra round-trip when
  // there's at least one promoted doc; skipped entirely otherwise.
  const parentIds = Array.from(
    new Set(summaries.map((s) => s.parentDocId).filter((id): id is string => !!id)),
  );
  if (parentIds.length > 0) {
    const parents = await db
      .select({
        id: documents.id,
        handle: documents.handle,
        title: documents.title,
        docType: documents.docType,
      })
      .from(documents)
      .where(
        and(eq(documents.memexId, memexId), inArray(documents.id, parentIds)),
      );
    const parentById = new Map(parents.map((p) => [p.id, p]));
    for (const s of summaries) {
      if (s.parentDocId) {
        s.parent = parentById.get(s.parentDocId) ?? null;
      }
    }
  }

  if (opts.includeAcHealth && summaries.length > 0) {
    // AC health is a Spec-only concept (acs.brief_id is NOT NULL and references
    // documents where docType='spec'). Filter to Spec docIds before calling
    // the aggregator — non-Spec summaries get no acHealth field, matching the
    // restraint pattern includeDriftCount uses for standards-only drift.
    const briefDocIds = summaries
      .filter((s) => s.docType === "spec")
      .map((s) => s.id);
    if (briefDocIds.length > 0) {
      const healthByBrief = await aggregateAcHealthForBriefs(memexId, briefDocIds);
      for (const s of summaries) {
        if (s.docType !== "spec") continue;
        const h = healthByBrief.get(s.id);
        // Skip attachment when totalActive is 0 — absence IS the signal that
        // the Spec has no commitments yet (b-66 Scope AC-4). The card UI
        // checks `s.acHealth === undefined || s.acHealth.totalActive === 0`
        // and renders the card with no border/chip/strip in both cases; keeping
        // the wire shape sparse means the same response works for legacy
        // clients that don't know about acHealth at all.
        if (h && h.totalActive > 0) s.acHealth = h;
      }
    }
  }

  if (opts.includeAssignees && summaries.length > 0) {
    // spec-118 ac-18: roll up assignees for the Spec summaries in one query. Like
    // acHealth, this is a Spec-board concern — attach to every summary that has at
    // least one assignee; Specs with none leave `assignees` unset so the card's
    // "Unassigned" branch trips.
    const specIds = summaries.filter((s) => s.docType === "spec").map((s) => s.id);
    const byDoc = await listAssigneesForDocs(memexId, specIds);
    for (const s of summaries) {
      const a = byDoc.get(s.id);
      if (a && a.length > 0) {
        s.assignees = a.map((v) => ({ userId: v.userId, name: v.name, email: v.email }));
      }
    }
  }

  if (opts.includeDriftCount && summaries.length > 0) {
    // Drift is a standards-only concept (b-63): only Standards can carry a drift
    // count. Restricting to standard docIds keeps this affordance from ever
    // surfacing non-standard drift, even if a stray comment is forced in — it
    // mirrors the read-side filter in services/drift-inbox.ts. Non-standard
    // summaries are left with `driftCount` unset.
    const standardDocIds = summaries
      .filter((s) => s.docType === "standard")
      .map((s) => s.id);
    if (standardDocIds.length > 0) {
      // Single grouped count over doc_sections → doc_comments, scoped to this account and
      // open drift comments. O(matching rows), no per-doc round-trip.
      const driftRows = await db
        .select({
          docId: docSections.docId,
          c: sql<number>`count(${docComments.id})::int`,
        })
        .from(docComments)
        .innerJoin(docSections, eq(docComments.sectionId, docSections.id))
        .where(
          and(
            eq(docComments.memexId, memexId),
            eq(docComments.commentType, "drift"),
            isNull(docComments.resolvedAt),
            inArray(docSections.docId, standardDocIds),
          ),
        )
        .groupBy(docSections.docId);
      const byDoc = new Map<string, number>();
      for (const r of driftRows) byDoc.set(r.docId, Number(r.c));
      for (const s of summaries) {
        if (s.docType === "standard") s.driftCount = byDoc.get(s.id) ?? 0;
      }
    }
  }

  return summaries;
}

// ── Spec lineage (t-2 / dec-11) ──────────────────────────
// Specs form a tree via documents.parent_doc_id. promoteToSpec creates a child
// Spec that points back at its source; getSpecLineage walks the parent chain up
// and returns the chain in root→leaf order (with the requested doc itself as the leaf).
// All walks are scoped to the requesting account — a parent FK pointing into another
// account is treated as a missing edge so cross-tenant lineage can't leak.

export async function getSpecLineage(
  memexId: string,
  docId: string,
): Promise<Doc[]> {
  // Anchor the walk on the requested doc. If the caller passes a doc from another
  // account, we 404 here — the caller never receives a partial chain.
  const start = await db.query.documents.findFirst({
    where: and(eq(documents.id, docId), eq(documents.memexId, memexId)),
  });
  if (!start) {
    throw new NotFoundError(`Document ${docId} not found`);
  }

  const chain: Doc[] = [start];
  // Cycle-safe: a malformed parent_doc_id (loop) terminates the walk instead of looping
  // forever. The breaking row is included once; we don't error so a corrupted edge
  // doesn't make the whole lineage view unreachable.
  const visited = new Set<string>([start.id]);
  let cursor: Doc = start;
  while (cursor.parentDocId) {
    if (visited.has(cursor.parentDocId)) break;
    const parent = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, cursor.parentDocId),
        eq(documents.memexId, memexId),
      ),
    });
    if (!parent) break;
    chain.push(parent);
    visited.add(parent.id);
    cursor = parent;
  }
  return chain.reverse();
}

export async function promoteToSpec(
  memexId: string,
  sourceDocId: string,
  title: string,
  purpose?: string,
  createdByUserId?: string,
  // spec-122 dec-2/dec-5 — the activity contract (WHO + HOW), threaded onto BOTH
  // the createDocDraft create AND the lineage re-emit below so a promoted Spec is
  // attributed to the human + surface exactly like a fresh create. Defaults empty
  // for seed/system callers.
  ctx: RequestCtx = {},
): Promise<Mutated<Doc & { sections: DocSection[]; decisions: Decision[] }>> {
  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (trimmedTitle.length === 0) {
    throw new ValidationError("Title must be a non-empty string");
  }

  const source = await db.query.documents.findFirst({
    where: and(eq(documents.id, sourceDocId), eq(documents.memexId, memexId)),
  });
  if (!source) {
    throw new NotFoundError(`Document ${sourceDocId} not found`);
  }

  const child = await createDocDraft(
    memexId,
    trimmedTitle,
    purpose ?? `Promoted from ${source.handle}.`,
    "spec",
    undefined,
    undefined,
    createdByUserId,
    ctx,
  );

  // Re-emit on promotion specifically — createDocDraft already fired a "created" event,
  // but the lineage edge is what downstream UI/MCP cares about, so let consumers see
  // the linked state too.
  return mutate(
    { ...ctx, actorUserId: ctx.actorUserId ?? createdByUserId },
    { memexId, docId: child.id, entity: "document", action: "updated" },
    async () => {
      const [linked] = await db
        .update(documents)
        .set({ parentDocId: source.id })
        .where(and(eq(documents.id, child.id), eq(documents.memexId, memexId)))
        .returning();
      return { ...linked, sections: child.sections, decisions: child.decisions };
    },
  );
}

export interface GetDocOptions {
  includeArchived?: boolean;
}

export async function getDoc(
  memexId: string,
  idOrHandle: string,
  opts: GetDocOptions = {},
): Promise<
  Doc & {
    sections: DocSection[];
    creator: { name: string | null; email: string | null } | null;
    // spec-178 dec-8 / ac-28: for is_demo docs, the per-phase value-banner copy
    // (a fixture CONSTANT keyed by the doc's phase) the UI renders atop the demo
    // spec. Unset for non-demo docs and for any demo phase with no callout.
    demoValueCallout?: string;
  }
> {
  const idMatch = isUuid(idOrHandle)
    ? eq(documents.id, idOrHandle)
    : eq(documents.handle, idOrHandle);
  const conditions = [idMatch, eq(documents.memexId, memexId)];
  if (!opts.includeArchived) conditions.push(isNull(documents.archivedAt));

  const doc = await db.query.documents.findFirst({
    where: and(...conditions),
  });

  if (!doc) {
    // 404 (not 403) so cross-account requests don't reveal that the resource exists.
    // Archived docs also 404 by default — the caller must opt in via includeArchived.
    throw new NotFoundError(`Document ${idOrHandle} not found`);
  }

  // Exclude soft-deleted sections (spec-107 dec-2). NULL is treated as active
  // for rows that predate the status column / migration window.
  const sections = await db
    .select()
    .from(docSections)
    .where(
      and(
        eq(docSections.docId, doc.id),
        sql`(${docSections.status} <> 'deleted' OR ${docSections.status} IS NULL)`,
      ),
    )
    .orderBy(docSections.seq);

  // Optional creator projection (migration 0036). Skipped entirely when the doc
  // pre-dates the column or its creator was wiped (FK is ON DELETE SET NULL).
  let creator: { name: string | null; email: string | null } | null = null;
  if (doc.createdByUserId) {
    const [u] = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, doc.createdByUserId));
    if (u) creator = u;
  }

  // spec-178 dec-8 / ac-28: a demo Spec carries its phase's value-banner copy from
  // the fixture (a per-phase CONSTANT, never stored on the row). Non-demo docs are
  // untouched — no field is attached, so the wire shape is identical for them.
  if (doc.isDemo) {
    const callout = HANDHOLD_PHASES.find((p) => p.phase === doc.status)?.valueCallout;
    if (callout !== undefined) {
      return { ...doc, sections, creator, demoValueCallout: callout };
    }
  }

  return { ...doc, sections, creator };
}

export async function updateDocTitle(memexId: string, id: string, title: string): Promise<Mutated<Doc>> {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (trimmed.length === 0) {
    throw new ValidationError("Title must be a non-empty string");
  }
  if (trimmed.length > 500) {
    throw new ValidationError("Title must be 500 characters or fewer");
  }

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }

  return mutate(
    {},
    { memexId, docId: id, entity: "document", action: "updated" },
    async () => {
      const [updated] = await db
        .update(documents)
        .set({ title: trimmed })
        .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function archiveDoc(memexId: string, id: string): Promise<Mutated<Doc>> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }
  // Idempotent: already-archived docs succeed without bumping the timestamp.
  // silent: true — no DB write, no observable state change, no need to emit.
  if (doc.archivedAt) {
    return mutate(
      {},
      { memexId, docId: id, entity: "document", action: "updated" },
      async () => doc,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: id, entity: "document", action: "updated" },
    async () => {
      const [updated] = await db
        .update(documents)
        .set({ archivedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

// Pause/unpause are Spec-only flags but the column is on `documents` so the
// query is uniform. Idempotent in both directions per the archive convention.
// Per doc-12 Out-of-Scope: pause/resume are React-UI-only — not exposed over MCP.
export async function pauseDoc(memexId: string, id: string): Promise<Mutated<Doc>> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }
  if (doc.pausedAt) {
    return mutate(
      {},
      { memexId, docId: id, entity: "document", action: "updated" },
      async () => doc,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: id, entity: "document", action: "updated" },
    async () => {
      const [updated] = await db
        .update(documents)
        .set({ pausedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

export async function unpauseDoc(memexId: string, id: string): Promise<Mutated<Doc>> {
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }
  if (!doc.pausedAt) {
    return mutate(
      {},
      { memexId, docId: id, entity: "document", action: "updated" },
      async () => doc,
      { silent: true },
    );
  }

  return mutate(
    {},
    { memexId, docId: id, entity: "document", action: "updated" },
    async () => {
      const [updated] = await db
        .update(documents)
        .set({ pausedAt: null })
        .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
        .returning();
      return updated;
    },
  );
}

// Re-export from the central enum (types/roles.ts) so the admin / route surface
// keeps a single source of truth. The Spec rename in doc-10 (`review`→`plan`,
// `implementation`→`build`, plus new `verify`) widens DOC_STATUSES; non-Spec
// docTypes still use the legacy values, so `'approved'` and friends remain valid.
import { DOC_STATUSES, SPEC_STATUSES, type DocStatus, type SpecStatus } from "../types/roles.js";
export { DOC_STATUSES, SPEC_STATUSES, type DocStatus, type SpecStatus };

// Per dec-6 of doc-12 the lifecycle is a guide, not a contract: the service
// layer no longer hard-blocks any status transition. Forward / backward /
// done is up to the caller. The agent surfaces (REST `/api/llm/chat`, MCP
// `update_doc_status`, MCP `publish_brief`) emit a soft nudge or a strong
// dec-3 warning when an agent closes a Spec without first running
// `assess_phase_transition`. `opts.source` is preserved as a hook for future
// per-source logging / telemetry; today nothing reads it.
//
// spec-189: `opts.ctx` threads the originating channel into the emitted
// events (Pulse attribution for traffic-driven auto-advances) and
// `opts.narrative` overrides the default status_changed prose so automatic
// transitions read as auto-advanced rather than humanly moved. Both
// optional — existing callers are unchanged.
export async function updateDocStatus(
  memexId: string,
  id: string,
  status: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts: { source?: "agent" | "rest"; ctx?: RequestCtx; narrative?: string } = {},
): Promise<Mutated<Doc>> {
  if (!(DOC_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(
      `Invalid status '${status}'. Must be one of: ${DOC_STATUSES.join(", ")}`
    );
  }

  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, id), eq(documents.memexId, memexId)),
  });
  if (!doc) {
    throw new NotFoundError(`Document ${id} not found`);
  }

  // spec-179 (ac-5): a Spec status flip emits a second, payload-carrying event
  // alongside the plain "updated" one (per std-8 dec-2: one event per logical
  // change). The activity-log sink persists it, giving an immutable {from, to}
  // transition history — documents.statusChangedAt only ever holds the latest
  // change, which is why phase durations were previously unrecoverable.
  const keys: ChangeKey[] = [{ memexId, docId: id, entity: "document", action: "updated" }];
  if (doc.docType === "spec" && doc.status !== status) {
    keys.push({
      memexId,
      docId: id,
      entity: "document",
      action: "status_changed",
      narrative: opts.narrative ?? `moved ${doc.handle} ${doc.status} → ${status}`,
      payload: { from: doc.status, to: status },
    });
  }

  const updated = await mutate(
    opts.ctx ?? {},
    keys,
    async () => {
      const [row] = await db
        .update(documents)
        .set({ status, statusChangedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.memexId, memexId)))
        .returning();
      return row;
    },
  );

  // spec-112 ac-24: a child Spec promoted from an Issue (promoteFromIssueRef)
  // reaching `done` auto-resolves its source Issue (converted→resolved). Service-
  // layer placement so it fires for any caller (UI, MCP, agent). Best-effort:
  // never fail the status write if the hook hiccups.
  if (status === "done") {
    await maybeAutoResolveIssuesForPromotedDoc(memexId, id).catch(() => {});
  }

  return updated;
}
