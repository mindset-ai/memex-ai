import type { SpecPhase } from "@memex/shared";
import { getDoc } from "../services/documents.js";
import { listDecisions } from "../services/decisions.js";
import { listTasks } from "../services/tasks.js";
import { reviewDocComments } from "../services/comments.js";
import { listDriftInbox, type DriftInboxRow } from "../services/drift-inbox.js";
import { buildChildRef, buildDocRef, memexSlugsById } from "../mcp/refs.js";
import { NotFoundError } from "../types/errors.js";

export type DocumentContext = {
  context: string;
  phase: SpecPhase;
};

/**
 * Map a raw doc status (legacy + canonical Spec phases) onto the
 * five-element SpecPhase enum. Mirrors `phaseFromStatus` in
 * `mcp/formatters.ts` (kept local to avoid cross-module coupling). Non-Spec
 * statuses fall back to `'plan'` — generic enough as a default prompt shape.
 */
function statusToPhase(status: string): SpecPhase {
  switch (status) {
    case "draft":
      return "draft";
    case "plan":
    case "review":
      return "plan";
    case "build":
    case "implementation":
      return "build";
    case "verify":
      return "verify";
    case "done":
    case "approved":
      return "done";
    default:
      return "plan";
  }
}

/**
 * Fetches full document state and serializes it into structured text
 * for inclusion in the agent's system prompt. Also returns the Spec phase
 * derived from the doc's `status` so the caller can pick the right
 * per-phase prompt (b-33: phases/ refactor).
 *
 * Refs over UUIDs: the agent-facing context leads with canonical refs
 * (e.g. `mindset-prod/memex/briefs/b-68/sections/s-1`) and intentionally
 * omits row UUIDs. The MCP tool boundary rejects UUIDs and the agent's
 * mutation-protocol skill already tells it the same — showing UUIDs here
 * contradicts both and pushes the agent into trial-and-error ref construction.
 */
export async function buildDocumentContext(
  memexId: string,
  docId: string,
): Promise<DocumentContext> {
  const [doc, allDecisions, allTasks, openComments, slugs] = await Promise.all([
    getDoc(memexId, docId),
    listDecisions(memexId, docId),
    listTasks(memexId, docId),
    reviewDocComments(memexId, docId),
    memexSlugsById(memexId),
  ]);

  if (!slugs) {
    // Defensive — memexId came from authorized middleware, so this can only
    // fire if the memex row vanished mid-request. Surface a clear error
    // rather than emitting a half-formed ref the agent will mis-use.
    throw new NotFoundError(`Memex ${memexId} not found`);
  }

  const docRef = buildDocRef(slugs, doc);
  const sectionsSorted = [...doc.sections].sort((a, b) => a.seq - b.seq);

  const lines: string[] = [];

  // Document header — lead with the canonical ref. Handle/Type/Status stay
  // as human-readable cues; UUID drops out (see fn-level comment).
  lines.push(`# Document: ${doc.title}`);
  lines.push(`Ref: ${docRef}`);
  lines.push(`Handle: ${doc.handle} | Type: ${doc.docType} | Status: ${doc.status}`);
  lines.push("");

  // ## Refs — a copy-pasteable enumeration of every mutable canonical ref
  // the agent might need. Eliminates the "concatenate the path yourself"
  // step that was the proximate cause of the b-68 ref loop.
  lines.push("## Refs");
  lines.push(`Doc: ${docRef}`);
  if (sectionsSorted.length > 0) {
    lines.push("Sections:");
    for (const s of sectionsSorted) {
      const ref = buildChildRef(slugs, doc, { type: "sections", seq: s.seq });
      lines.push(`- ${ref} — ${s.title ?? s.sectionType}`);
    }
  }
  if (allDecisions.length > 0) {
    lines.push("Decisions:");
    for (const d of allDecisions) {
      const ref = buildChildRef(slugs, doc, { type: "decisions", seq: d.seq });
      lines.push(`- ${ref} — ${d.title}`);
    }
  }
  if (allTasks.length > 0) {
    lines.push("Tasks:");
    for (const t of allTasks) {
      const ref = buildChildRef(slugs, doc, { type: "tasks", seq: t.seq });
      lines.push(`- ${ref} — ${t.title}`);
    }
  }
  lines.push("");

  // Sections — heading uses the s-N handle (matches dec-/t- convention).
  lines.push("## Sections");
  for (const s of sectionsSorted) {
    lines.push(`### s-${s.seq}: ${s.title ?? s.sectionType}`);
    lines.push(s.content);
    lines.push("");
  }

  // Decisions
  if (allDecisions.length > 0) {
    lines.push("## Decisions");
    for (const d of allDecisions) {
      lines.push(`- **dec-${d.seq}**: ${d.title}`);
      lines.push(`  Status: ${d.status}`);
      if (d.context) lines.push(`  Context: ${d.context}`);
      if (d.resolution) lines.push(`  Resolution: ${d.resolution}`);
    }
    lines.push("");
  }

  // Tasks
  if (allTasks.length > 0) {
    lines.push("## Tasks");
    for (const t of allTasks) {
      lines.push(`- **t-${t.seq}**: ${t.title}`);
      lines.push(`  Status: ${t.status} | Blocked: ${t.blocked}`);
      if (t.description) lines.push(`  Description: ${t.description}`);
      if (t.blockedByDecisions.length > 0) {
        const blockers = t.blockedByDecisions.map((d) => `dec-${d.seq}`).join(", ");
        lines.push(`  Blocked by decisions: ${blockers}`);
      }
      if (t.blockedByTasks.length > 0) {
        const blockers = t.blockedByTasks.map((bt) => `t-${bt.seq}`).join(", ");
        lines.push(`  Blocked by tasks: ${blockers}`);
      }
    }
    lines.push("");
  }

  // Open comments — referenced by c-N handle (matches mutation-protocol).
  const hasOpenComments =
    openComments.sections.length > 0 ||
    openComments.decisions.length > 0 ||
    openComments.tasks.length > 0;

  if (hasOpenComments) {
    lines.push("## Open Comments");
    for (const entry of openComments.sections) {
      lines.push(`### On s-${entry.section.seq}: ${entry.section.title ?? entry.section.sectionType}`);
      for (const c of entry.comments) {
        lines.push(`- [${c.authorName}] c-${c.seq}: ${c.content}`);
      }
    }
    for (const entry of openComments.decisions) {
      lines.push(`### On dec-${entry.decision.seq}: ${entry.decision.title}`);
      for (const c of entry.comments) {
        lines.push(`- [${c.authorName}] c-${c.seq}: ${c.content}`);
      }
    }
    for (const entry of openComments.tasks) {
      lines.push(`### On t-${entry.task.seq}: ${entry.task.title}`);
      for (const c of entry.comments) {
        lines.push(`- [${c.authorName}] c-${c.seq}: ${c.content}`);
      }
    }
    lines.push("");
  }

  return {
    context: lines.join("\n"),
    phase: statusToPhase(doc.status),
  };
}

/** spec-143: bodies in the drift context are truncated so a Memex with many
 *  open items can't blow the context window. ~500 chars keeps each observation /
 *  proposal / current-rule legible while bounding total size; the agent pulls the
 *  full text with `get_doc` / `list_comments` when it needs to act on an item. */
const DRIFT_BODY_MAX = 500;

function truncateBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DRIFT_BODY_MAX) return trimmed;
  return `${trimmed.slice(0, DRIFT_BODY_MAX).trimEnd()}…`;
}

/**
 * spec-143: builds the agent context for DRIFT mode — the OPEN drift across this
 * Memex's Standards, grouped by Standard, with the ACTUAL observation / proposal
 * text the agent needs to reason about and handle each item (not just counts).
 * Reuses `listDriftInbox` (the same read the Drift Inbox UI uses) so the agent's
 * picture and the user's picture are the same set of items.
 *
 * Per Standard: the handle, title, a canonical Standard ref the agent can pass to
 * tools, the section's CURRENT rule text (the "before"), then each open item —
 * an OBSERVATION (the `drift` comment body) or a PROPOSAL (the `plan_revision`
 * body plus its proposed replacement text, the "after"). Bodies are truncated
 * (DRIFT_BODY_MAX) so the context stays bounded; the closing note tells the agent
 * how to fetch exact refs (`list_comments` for the c-N comment ref, `get_doc` for
 * the s-N section ref) before it mutates.
 *
 * Returns `phase: 'plan'` — drift mode is not a Spec phase, but buildSystemBlocks
 * still needs a base phase to project the general orientation; the drift overlay
 * is what gives the agent its actual job. Empty when there is no open drift.
 */
export async function buildDriftContext(
  memexId: string,
): Promise<DocumentContext> {
  // 200 is the service hard cap — enough to summarize a Memex's open drift in
  // one read. The agent fetches per-item detail with its tools when it needs it.
  // The slug lookup (one query) lets us build a canonical Standard ref per group.
  const [page, slugs] = await Promise.all([
    listDriftInbox(memexId, { limit: 200 }),
    memexSlugsById(memexId),
  ]);
  const items = page.items;

  if (items.length === 0) {
    return {
      context:
        "Open drift: none. There are no open drift observations or proposed Standard changes in this Memex right now. Let the user know the Standards are clear of open drift, and offer to help if they want to flag a new drift finding or review a Standard.",
      phase: "plan",
    };
  }

  // Group by Standard (doc handle), preserving first-seen order (the service
  // returns newest-first). Carry the items themselves so we can render each
  // observation / proposal body, plus a count split for the per-standard header.
  type Group = {
    handle: string;
    title: string;
    docType: string;
    /** First section content seen for this Standard — the CURRENT rule ("before"). */
    currentRule: string | null;
    observations: number;
    proposals: number;
    items: DriftInboxRow[];
  };
  const byHandle = new Map<string, Group>();
  for (const item of items) {
    let g = byHandle.get(item.doc.handle);
    if (!g) {
      g = {
        handle: item.doc.handle,
        title: item.doc.title,
        docType: item.doc.docType,
        currentRule: null,
        observations: 0,
        proposals: 0,
        items: [],
      };
      byHandle.set(item.doc.handle, g);
    }
    if (g.currentRule === null && item.section?.content) {
      g.currentRule = item.section.content;
    }
    if (item.commentType === "plan_revision") g.proposals += 1;
    else g.observations += 1;
    g.items.push(item);
  }

  const groups = [...byHandle.values()];
  const lines: string[] = [];
  lines.push(
    `Open drift: ${items.length} item${items.length === 1 ? "" : "s"} across ${
      groups.length
    } standard${groups.length === 1 ? "" : "s"}. The actual observation / proposal text for each item is below, grouped by Standard.`,
  );
  lines.push("");

  for (const g of groups) {
    const parts: string[] = [];
    if (g.observations > 0) {
      parts.push(`${g.observations} observation${g.observations === 1 ? "" : "s"}`);
    }
    if (g.proposals > 0) {
      parts.push(`${g.proposals} proposal${g.proposals === 1 ? "" : "s"}`);
    }
    // A canonical Standard ref the agent can pass straight to its tools. Falls
    // back to the bare handle if the memex row vanished mid-request (defensive —
    // memexId came from authorized middleware, so slugs are normally present).
    const standardRef = slugs
      ? buildDocRef(slugs, { docType: g.docType, handle: g.handle })
      : g.handle;
    lines.push(`## ${g.handle} "${g.title}" — ${parts.join(", ")}`);
    lines.push(`Standard ref: ${standardRef}`);
    if (g.currentRule) {
      lines.push("Current rule (the section text drift is measured against):");
      lines.push(truncateBody(g.currentRule));
    }
    lines.push("");
    for (const item of g.items) {
      // spec-143 i-2: each line leads with the item's c-N handle — the same ref
      // the inbox rows display — so the agent and the user name the same item
      // and the agent can act on it without a list_comments recovery trip.
      if (item.commentType === "plan_revision") {
        lines.push(
          `- PROPOSAL ${item.commentHandle} by ${item.authorName}: ${truncateBody(item.content)}`,
        );
        if (item.proposedContent) {
          lines.push(`  Proposed new rule: ${truncateBody(item.proposedContent)}`);
        }
      } else {
        lines.push(
          `- OBSERVATION ${item.commentHandle} by ${item.authorName}: ${truncateBody(item.content)}`,
        );
      }
    }
    lines.push("");
  }

  lines.push(
    "Each item above carries its comment ref (c-N). The Drift Inbox shows the user the same " +
      'item as "Drift #N" / "Proposed change #N" — "#N" IS c-N, so when the user (or a ' +
      "[Focus: …] prefix) says \"#2\", act on c-2 and call it \"#2\" back to them. To ACT on " +
      "an item: resolve its comment with `update_comment` using the c-N ref directly; to apply " +
      "a rule change first call `get_doc` on the Standard to read the section ref (s-N), then " +
      "`update_section`; record a new proposal with `propose_standard_change` — each gated by " +
      "`render_confirmation` first.",
  );

  return {
    context: lines.join("\n"),
    phase: "plan",
  };
}
