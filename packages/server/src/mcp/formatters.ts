import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Doc, DocSection, DocComment, Decision, Task, Tag } from "../db/schema.js";
import { formatTag } from "../services/tags.js";
import type { DocSummary } from "../types/index.js";
import type { TaskWithBlockers } from "../services/tasks.js";
import type { DocCommentsResult } from "../services/comments.js";
import type { ExecutionPlan } from "../services/execution_plans.js";
import type { DecisionOption } from "../services/decisions.js";
import type {
  StandardListEntry,
  StandardWithSections,
  AffectedStandardMatch,
} from "../services/standards.js";
import { buildChildRef, buildDocRef, docTypeForUrl } from "./refs.js";
import { formatRef } from "../services/refs.js";
import {
  BASE_SCAFFOLD,
  BUILD_AC_NAG_PROSE,
  toNudge,
  type GuidanceBlock,
  type PhaseNode,
} from "@memex/shared";
import type { AcWithVerification } from "../services/acs.js";

// b-33 / b-68 t-7: per-phase static prose (intent, allowance, footer,
// behavioural blocks, code-grounding nudge, standards protocol) is now driven
// by `BASE_SCAFFOLD` + `toNudge` from `@memex/shared` (one model, many
// projections — b-68 dec-6). The `agent/phases/<phase>/mcp-footer.md` and
// `mcp-descriptions.md` files this module used to read have been retired.
// `_base/standards-protocol.md` is the only remaining file read here; it lives
// outside the per-phase folders and is unrelated to nudge composition (mirrors
// the path-resolution pattern in `agent/skills.ts`).
const __formattersDirname = dirname(fileURLToPath(import.meta.url));
const PHASES_DIR = resolve(__formattersDirname, "..", "agent", "phases");

function readPhaseFile(phase: string, file: string): string {
  return readFileSync(resolve(PHASES_DIR, phase, file), "utf8").trimEnd();
}

// b-36 T-6: a formatter-side "ref context" lets callers feed in the
// namespace/memex slugs (cheap, derived from the input ref) so child
// formatters can compose canonical refs without re-querying the DB.
// Optional throughout — when absent, formatters fall back to the bare handle.
export type FormatterRefContext = { namespace: string; memex: string };

function maybeDocRef(
  slugs: FormatterRefContext | undefined,
  doc: Pick<Doc, "docType" | "handle">,
): string {
  return slugs ? buildDocRef(slugs, doc) : doc.handle;
}

function maybeChildRef(
  slugs: FormatterRefContext | undefined,
  doc: Pick<Doc, "docType" | "handle"> | undefined,
  type: "sections" | "decisions" | "tasks" | "comments",
  seq: number,
): string {
  if (!slugs || !doc) {
    const prefix = type === "sections" ? "s" : type === "decisions" ? "dec" : type === "tasks" ? "t" : "c";
    return `${prefix}-${seq}`;
  }
  return buildChildRef(slugs, doc, { type, seq });
}

// Suppress unused-import warnings — `formatRef` / `docTypeForUrl` are part of
// the formatter helper surface; downstream callers may import them indirectly.
void formatRef;
void docTypeForUrl;

// `formatStandardsSearch` was removed by b-34 — the standards-search module
// became `memex-search.ts`, and that module exports its own `formatSearchResults`
// helper (path-as-heading shape, no UUIDs, aligned with b-36 D-7/D-8).
// `maybeDocRef` and `maybeChildRef` are intentionally re-exported below if
// the new search formatter needs them; today they're internal helpers.

function formatDate(date: Date | null): string {
  if (!date) return "";
  return date.toISOString().slice(0, 10);
}

// Per doc-30 dec-4 + b-105 dec-6: typed top-level routes for typed top-level
// docs. Specs route at /specs/<handle>, standards at /standards/<handle>, and
// everything else (free-form documents, execution-plans) at /docs/<handle>.
// Matches the React Router config in packages/admin/src/App.tsx.
export function docUrl(appBaseUrl: string, docType: string, handle: string): string {
  if (docType === "standard") return `${appBaseUrl}/standards/${handle}`;
  if (docType === "spec") return `${appBaseUrl}/specs/${handle}`;
  return `${appBaseUrl}/docs/${handle}`;
}

interface AcceptanceCriterion {
  description: string;
  done: boolean;
}

// ══════════════════════════════════════
// Full Doc State (used by all mutation responses)
// ══════════════════════════════════════

/**
 * Context for the nudge channel — passed through `formatFullDocState` so the
 * phase guidance footer can call `toNudge({ tool, phase, orgBlocks })` with
 * the right targeting context. All fields optional: when omitted, the nudge
 * still composes (tool/phase undefined → only `target.tool === undefined` /
 * `target.phase === undefined` base blocks match).
 *
 * `tool` lets the MCP layer pass the name of the tool emitting this response
 * (e.g. `update_section`) so per-tool Org additions can attach to it. `phase`
 * is derived from the doc inside `formatSpecGuidance` and need not be passed.
 * `orgBlocks` carries the principal's Org's enabled `org_scaffold_additions`
 * rows, already filtered server-side per b-68 dec-1.
 */
export interface NudgeContext {
  tool?: string;
  orgBlocks?: readonly GuidanceBlock[];
}

// spec-136 t-4: one-line tag strip for a doc-state header. Renders structured
// tags back to their `scope::value`/flat string form via the canonical
// formatTag, so the agent sees exactly the strings it would pass back to
// update_doc({tags}). Returns null when the Spec carries no tags (no line).
function formatTagStrip(tags: Tag[] | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return `Tags: ${tags.map(formatTag).join(", ")}`;
}

export function formatFullDocState(
  doc: Doc & { sections: DocSection[] },
  decisions: Decision[],
  tasks: TaskWithBlockers[],
  appBaseUrl?: string,
  comments?: DocCommentsResult,
  slugs?: FormatterRefContext,
  nudge?: NudgeContext,
  acVerifications?: AcWithVerification[],
  // spec-136 t-4: appended LAST so the existing positional callers (and the
  // develop nudge/acVerifications params at 7/8) keep compiling unchanged.
  tags?: Tag[],
): string {
  const lines: string[] = [];

  // Task comment counts (open + resolved) keyed by task id
  const taskCommentCounts = new Map<string, { open: number; resolved: number }>();
  if (comments) {
    for (const { task, comments: taskComments } of comments.tasks) {
      const open = taskComments.filter((c) => !c.resolvedAt).length;
      const resolved = taskComments.filter((c) => c.resolvedAt).length;
      if (open > 0 || resolved > 0) {
        taskCommentCounts.set(task.id, { open, resolved });
      }
    }
  }

  // Header
  lines.push(`# ${doc.title} [${doc.status.toUpperCase()}]`);
  lines.push(`ref: ${maybeDocRef(slugs, doc)}`);
  lines.push(`Type: ${doc.docType} | Handle: ${doc.handle}`);
  lines.push(`Status: ${doc.status} (changed ${formatDate(doc.statusChangedAt)})`);
  if (appBaseUrl) {
    lines.push(`URL: ${docUrl(appBaseUrl, doc.docType, doc.handle)}`);
  }
  const tagStrip = formatTagStrip(tags);
  if (tagStrip) lines.push(tagStrip);
  lines.push("");

  // Sections
  for (let i = 0; i < doc.sections.length; i++) {
    const section = doc.sections[i];
    const num = i + 1;
    lines.push(`## ${num}. ${section.title ?? section.sectionType}`);
    lines.push(section.content);
    lines.push("");
    // spec-106 (ac-9 sectionType / ac-10 description): section metadata travels
    // in the read surface next to the ref. `description` is nullable — only
    // render the segment when present so an undescribed section stays terse.
    const descSegment = section.description ? ` | Description: ${section.description}` : "";
    lines.push(
      `Section #${num} | ref: ${maybeChildRef(slugs, doc, "sections", section.seq)} | Type: ${section.sectionType}${descSegment} | Updated: ${formatDate(section.updatedAt)}`,
    );
    lines.push("");
  }

  // Decisions
  if (decisions.length > 0) {
    // doc is the parent for every decision in this list (formatFullDocState is per-doc).
    lines.push(formatDecisionList(decisions, doc, slugs));
    lines.push("");
  }

  // Tasks
  if (tasks.length > 0) {
    lines.push(formatTaskList(tasks, taskCommentCounts, slugs, doc));
    lines.push("");
  }

  // Phase-aware guidance (Spec docs)
  if (doc.docType === "spec") {
    lines.push(formatSpecGuidance(doc, decisions, tasks, nudge, acVerifications));
  }

  return lines.join("\n").trimEnd();
}

// ══════════════════════════════════════
// Document List
// ══════════════════════════════════════

// ══════════════════════════════════════
// Memex list — entry-point formatter
// ══════════════════════════════════════
// Wraps list_memexes results with a one-line preamble and an explicit
// "ask the user which to operate in" footer. This is almost always the
// first tool a fresh agent calls, so the framing here doubles as session
// orientation: even if a client strips the McpServer `instructions`, this
// response carries the chooser rule into the conversation.
//
// Per F.5 of doc-15, identifiers are emitted in `<namespace>/<memex>` form
// (e.g. `mindset/website-rewrite`) — the same string the user types into
// the browser, and the same string scoped tools expect as their `memex`
// argument. Grouped by namespace so multi-memex orgs read cleanly.

export interface MemexListEntry {
  // Namespace slug (e.g. "mindset", or the user's personal namespace slug).
  slug: string;
  // Memex slug within the namespace (e.g. "main", "personal", "website-rewrite").
  memexSlug: string;
  name: string;
  kind: "personal" | "team";
  role: string;
}

/**
 * Optional appendix payload appended to the list_memexes output. Carries
 * the guidance-topic index so it lands in the agent's context on the
 * first orient call, regardless of whether the agent ever invokes
 * `get_information` on its own initiative.
 *
 * Why this lives here (vs in the agent reaching for get_information):
 * we observed empirically that fresh agents orient via list_memexes +
 * get_doc + list_acs + list_tasks + list_comments — and rarely call
 * get_information unprompted, even when the topic index is named in the
 * session-init prefix. Piggy-backing the index on the list_memexes
 * response guarantees the topic names land in tool-call history during
 * orientation, which raises the prior on calling get_information(topic)
 * later when a specific topic becomes load-bearing.
 */
export interface GuidanceTopicSummary {
  topic: string;
  title: string;
  whenToRead: string;
}

export function formatMemexList(
  memberships: MemexListEntry[],
  guidanceTopics: GuidanceTopicSummary[] = [],
): string {
  if (memberships.length === 0) {
    return [
      "You have no Memexes yet.",
      "",
      "A Memex is a workspace (docs, decisions, tasks, standards are scoped per Memex).",
      "Create a personal Memex by signing in to the React UI, or accept a team invite to join one.",
    ].join("\n");
  }

  // Group by namespace so a user in `mindset/main` + `mindset/website-rewrite`
  // sees the namespace heading once. Personal namespaces (single memex) still
  // render with the heading for visual consistency.
  const byNamespace = new Map<string, MemexListEntry[]>();
  for (const m of memberships) {
    const list = byNamespace.get(m.slug) ?? [];
    list.push(m);
    byNamespace.set(m.slug, list);
  }

  const lines: string[] = [];
  lines.push(
    "Each Memex is a separate workspace — docs, decisions, tasks, and standards are all scoped per Memex.",
  );
  lines.push("");
  lines.push("Your Memexes:");
  for (const [ns, entries] of byNamespace) {
    lines.push(`- **${ns}/**`);
    for (const m of entries) {
      const label = m.kind === "personal" ? "personal" : "team";
      lines.push(
        `  - \`${m.slug}/${m.memexSlug}\` — ${m.name} (${label}, role: ${m.role})`,
      );
    }
  }
  lines.push("");
  if (memberships.length === 1) {
    lines.push(
      "**Confirm with the user before mutating** — even with one Memex, don't assume it's the right place for the work.",
    );
  } else {
    lines.push(
      "**Ask the user which Memex to operate in** before any creation or mutation. Don't auto-pick the personal one; don't auto-pick the only team one.",
    );
  }
  lines.push(
    "Once chosen, pass it as `memex=<namespace>/<memex>` (e.g. `memex=mindset/website-rewrite`) to scoped tools (`list_docs`, `create_doc`, `search_memex`, …).",
  );

  // Operating-depth appendix. Piggy-backs the guidance-topic index on
  // the orient call so the topic names land in the agent's context
  // during normal orientation. The agent doesn't have to know to call
  // `get_information()` separately — the topics arrive as part of
  // figuring out which memex to work in.
  if (guidanceTopics.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Operating depth — fetch on demand via `get_information`");
    lines.push("");
    lines.push(
      "For depth on any concept the session-init spec doesn't spell out, call `get_information({topic: '<slug>'})`. Topics available right now:",
    );
    lines.push("");
    for (const t of guidanceTopics) {
      lines.push(`- **${t.topic}** — ${t.whenToRead}`);
    }
  }

  return lines.join("\n");
}

export function formatDocList(
  docs: DocSummary[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push("# Documents");
  lines.push("");

  for (const d of docs) {
    const url = appBaseUrl ? `\n  URL: ${docUrl(appBaseUrl, d.docType, d.handle)}` : "";
    const ref = maybeDocRef(slugs, d);
    lines.push(
      `- **${d.title}** (${d.handle}) [${d.status.toUpperCase()}] type: ${d.docType} — ${d.sectionCount} sections, created ${formatDate(d.createdAt)}, status changed ${formatDate(d.statusChangedAt)}\n  ref: ${ref}${url}`,
    );
  }

  lines.push("");
  lines.push(`${docs.length} documents total`);
  if (docs.length > 0) {
    lines.push("");
    lines.push("Open one with `get_doc({ref})` — the response carries phase + allowed-tools guidance.");
  }

  return lines.join("\n").trimEnd();
}

// ══════════════════════════════════════
// Doc status header (prepended to comment tool responses so status stays
// visible alongside section/decision/task-centric output).
// ══════════════════════════════════════

export function formatDocStatusHeader(doc: Doc): string {
  return `Doc: ${doc.title} (${doc.handle}) · Status: ${doc.status.toUpperCase()} (changed ${formatDate(doc.statusChangedAt)})`;
}

// ══════════════════════════════════════
// Comments
// ══════════════════════════════════════

// Badge for typed comments (t-8 / Section 7 of doc-10). Visible only when the comment
// carries a non-default type or non-default source — keeps existing `discussion`/`human`
// rendering byte-identical so old tests / consumers don't churn.
function commentBadge(comment: DocComment): string {
  const parts: string[] = [];
  if (comment.source && comment.source !== "human") parts.push(comment.source.toUpperCase());
  if (comment.commentType && comment.commentType !== "discussion") {
    parts.push(comment.commentType.toUpperCase());
  }
  if (parts.length === 0) return "";
  return ` [${parts.join(" · ")}]`;
}

// doc-26 t-5: cross_reference comments now carry one of four structured FK
// columns (referenceBriefId / referenceStandardId / referenceDecisionId /
// referenceTaskId). The rendered target handle is fetched via join through the
// FK so the line always shows the entity's CURRENT handle — no handle-string
// drift across renames. Callers can pre-resolve handles into the lookup map
// and pass it in; if no handle is available the kind is rendered alone (the
// FK existence is still visible via the suffix marker).
//
// b-105: the FK column `referenceBriefId` predates the Spec → Spec rename and
// remains as-is in the DB schema; the user-facing discriminator below is
// `"spec"` so emitted prose ("Cross-reference: spec → ...") matches the new
// vocabulary.
export type CommentReferenceLookup = Map<string, { kind: "spec" | "standard" | "decision" | "task"; handle: string }>;

function commentReferenceLine(
  comment: DocComment,
  lookup?: CommentReferenceLookup,
): string | null {
  // Prefer the resolved handle when the caller pre-fetched it; otherwise
  // surface the FK kind + UUID so the line still carries information when
  // a caller hasn't joined yet.
  const resolved = lookup?.get(comment.id);
  if (resolved) {
    return `Cross-reference: ${resolved.kind} → ${resolved.handle}`;
  }
  if (comment.referenceBriefId) return `Cross-reference: spec → (id: ${comment.referenceBriefId})`;
  if (comment.referenceStandardId) return `Cross-reference: standard → (id: ${comment.referenceStandardId})`;
  if (comment.referenceDecisionId) return `Cross-reference: decision → (id: ${comment.referenceDecisionId})`;
  if (comment.referenceTaskId) return `Cross-reference: task → (id: ${comment.referenceTaskId})`;
  return null;
}

export function formatComment(
  comment: DocComment,
  lookupOrSlugs?: CommentReferenceLookup | FormatterRefContext,
  doc?: Pick<Doc, "docType" | "handle">,
): string {
  // Per b-36 T-6 / T-2 the canonical comment ref leads the body. Older
  // callers pass a `CommentReferenceLookup` Map; new callers pass
  // `{namespace, memex}` slugs + the parent doc. We distinguish by shape.
  const lookup =
    lookupOrSlugs instanceof Map ? (lookupOrSlugs as CommentReferenceLookup) : undefined;
  const slugs =
    !lookup && lookupOrSlugs && typeof lookupOrSlugs === "object" && "namespace" in lookupOrSlugs
      ? (lookupOrSlugs as FormatterRefContext)
      : undefined;

  const status = comment.resolvedAt ? "[RESOLVED]" : "[OPEN]";
  const badge = commentBadge(comment);
  const headerLines: string[] = [];
  if (slugs && doc) {
    const ref = buildChildRef(slugs, doc, { type: "comments", seq: comment.seq });
    headerLines.push(`ref: ${ref}`);
  }
  headerLines.push(
    `${status}${badge} **${comment.authorName}** (${formatDate(comment.createdAt)}):`,
    comment.content,
  );
  const refLine = commentReferenceLine(comment, lookup);
  if (refLine) headerLines.push(refLine);
  if (comment.resolution) {
    headerLines.push(`Resolution: ${comment.resolution}`);
  }
  return headerLines.join("\n");
}

export function formatDocComments(
  result: DocCommentsResult,
  slugs?: FormatterRefContext,
  parentDoc?: Pick<Doc, "docType" | "handle">,
): string {
  const { sections, decisions, tasks } = result;
  const total =
    sections.reduce((n, e) => n + e.comments.length, 0) +
    decisions.reduce((n, e) => n + e.comments.length, 0) +
    tasks.reduce((n, e) => n + e.comments.length, 0);

  if (total === 0) return "No comments on this document.";

  const lines: string[] = [];
  lines.push(`# Comments (${total} total)`);
  lines.push("");

  for (const { section, comments } of sections) {
    lines.push(`## Section: ${section.title ?? section.sectionType}`);
    if (parentDoc) {
      lines.push(`Section ref: ${maybeChildRef(slugs, parentDoc, "sections", section.seq)}`);
    }
    lines.push("");
    for (const c of comments) {
      lines.push(formatComment(c, slugs, parentDoc));
      lines.push("");
    }
  }

  for (const { decision, comments } of decisions) {
    lines.push(`## Decision: dec-${decision.seq} — ${decision.title}`);
    if (parentDoc) {
      lines.push(`Decision ref: ${maybeChildRef(slugs, parentDoc, "decisions", decision.seq)}`);
    }
    lines.push("");
    for (const c of comments) {
      lines.push(formatComment(c, slugs, parentDoc));
      lines.push("");
    }
  }

  for (const { task, comments } of tasks) {
    lines.push(`## Task: t-${task.seq} — ${task.title}`);
    if (parentDoc) {
      lines.push(`Task ref: ${maybeChildRef(slugs, parentDoc, "tasks", task.seq)}`);
    }
    lines.push("");
    for (const c of comments) {
      lines.push(formatComment(c, slugs, parentDoc));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

export function formatReviewComments(
  result: DocCommentsResult,
  slugs?: FormatterRefContext,
  parentDoc?: Pick<Doc, "docType" | "handle">,
): string {
  const { sections, decisions, tasks } = result;
  const total =
    sections.reduce((n, e) => n + e.comments.length, 0) +
    decisions.reduce((n, e) => n + e.comments.length, 0) +
    tasks.reduce((n, e) => n + e.comments.length, 0);

  if (total === 0) return "No open comments to review.";

  const lines: string[] = [];
  lines.push(`# Review: ${total} open comments`);
  lines.push("");
  lines.push(
    "For each comment, consider the feedback in context. " +
    "Use update_section / resolve_decision / update_task({status}) to make changes, " +
    "then update_comment({ref, status: 'resolved', resolution}) describing what was done."
  );
  lines.push("");

  for (const { section, comments } of sections) {
    lines.push("---");
    lines.push("");
    lines.push(`## Section: ${section.title ?? section.sectionType}`);
    if (parentDoc) {
      lines.push(`Section ref: ${maybeChildRef(slugs, parentDoc, "sections", section.seq)}`);
    }
    lines.push("");
    lines.push("### Current content");
    lines.push(section.content);
    lines.push("");
    lines.push(`### Open comments (${comments.length})`);
    for (const c of comments) {
      lines.push(formatComment(c, slugs, parentDoc));
      lines.push("");
    }
  }

  for (const { decision, comments } of decisions) {
    lines.push("---");
    lines.push("");
    lines.push(`## Decision: dec-${decision.seq} — ${decision.title} [${decision.status.toUpperCase()}]`);
    if (parentDoc) {
      lines.push(`Decision ref: ${maybeChildRef(slugs, parentDoc, "decisions", decision.seq)}`);
    }
    if (decision.context) {
      lines.push("");
      lines.push("### Context");
      lines.push(decision.context);
    }
    lines.push("");
    lines.push(`### Open comments (${comments.length})`);
    for (const c of comments) {
      lines.push(formatComment(c, slugs, parentDoc));
      lines.push("");
    }
  }

  for (const { task, comments } of tasks) {
    lines.push("---");
    lines.push("");
    lines.push(`## Task: t-${task.seq} — ${task.title} [${task.status.toUpperCase()}]`);
    if (parentDoc) {
      lines.push(`Task ref: ${maybeChildRef(slugs, parentDoc, "tasks", task.seq)}`);
    }
    lines.push("");
    lines.push("### Description");
    lines.push(task.description);
    lines.push("");
    lines.push(`### Open comments (${comments.length})`);
    for (const c of comments) {
      lines.push(formatComment(c, slugs, parentDoc));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

export function formatCommentList(
  comments: DocComment[],
  slugs?: FormatterRefContext,
  doc?: Pick<Doc, "docType" | "handle">,
): string {
  if (comments.length === 0) return "No comments on this section.";

  const open = comments.filter((c) => !c.resolvedAt);
  const resolved = comments.filter((c) => c.resolvedAt);

  const lines: string[] = [];
  lines.push(`# Comments (${open.length} open, ${resolved.length} resolved)`);
  lines.push("");

  for (const c of open) {
    lines.push(formatComment(c, slugs, doc));
    lines.push("");
  }

  if (resolved.length > 0) {
    lines.push("---");
    lines.push("## Resolved");
    lines.push("");
    for (const c of resolved) {
      lines.push(formatComment(c, slugs, doc));
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

// ══════════════════════════════════════
// Decisions
// ══════════════════════════════════════

function decisionStatusBadge(decision: Decision): string {
  switch (decision.status) {
    case "resolved":
      return "[RESOLVED]";
    case "candidate":
      return "[CANDIDATE]";
    case "rejected":
      return "[REJECTED]";
    case "open":
    default:
      return "[OPEN]";
  }
}

// t-20 W-A: when a parent doc is in scope, surface the qualified `doc-N:D-M`
// handle as the canonical reference (Specs and free-form documents share the
// `doc-N` namespace per the revised doc-26). Falls back to the bare `D-M` form
// when no parent doc is supplied (the formatDecisionList caller path). The
// bare prefix is `D-`; the qualified suffix uses the parent's stored handle
// as-is.
function decisionRef(decision: Decision, parentDoc?: Doc): string {
  if (parentDoc?.handle) return `${parentDoc.handle}:D-${decision.seq}`;
  return `D-${decision.seq}`;
}

// Source pill — only rendered for non-default ('agent') values to keep the existing
// human-authored decision output byte-identical for legacy consumers.
function decisionSourcePill(decision: Decision): string {
  if (decision.source === "agent") return " [AGENT]";
  return "";
}

// b-97 t-1 dec-1: when a resolved decision has both `options` and a non-null
// `chosenOptionIndex`, surface the picked option's label inline so an agent
// reading `get_doc` markdown can see WHAT was chosen, not just the resolution
// prose. Returns null when the decision didn't go through the option-picker
// path (no options, or resolved without setting chosenOptionIndex) so the
// caller can decide whether to emit the line at all.
function decisionChoseLine(decision: Decision): string | null {
  if (decision.chosenOptionIndex === null || decision.chosenOptionIndex === undefined) {
    return null;
  }
  const options = (decision.options as DecisionOption[] | null) ?? [];
  const chosen = options[decision.chosenOptionIndex];
  if (!chosen) return null;
  return `  Chose: ${chosen.label}`;
}

// b-97 t-1 dec-1: surface the structured options on any decision that has
// them (open / candidate / resolved). An agent reading the spec can see
// what's on the table without calling `approve_candidate` or
// `get_decision_impact` to fetch the options separately. Returns null when
// no options are stored; the caller skips emitting the block entirely.
function decisionOptionsBlock(decision: Decision): string | null {
  const options = (decision.options as DecisionOption[] | null) ?? [];
  if (options.length === 0) return null;
  const chosen = decision.chosenOptionIndex;
  const lines = ["  Options:"];
  options.forEach((opt, idx) => {
    const marker = chosen === idx ? " ← CHOSEN" : "";
    lines.push(`    ${idx}. ${opt.label}${marker}`);
    if (opt.trade_offs) {
      lines.push(`       Trade-offs: ${opt.trade_offs}`);
    }
  });
  return lines.join("\n");
}

function formatDecision(
  decision: Decision,
  parentDoc?: Doc,
  slugs?: FormatterRefContext,
): string {
  const status = decisionStatusBadge(decision);
  const source = decisionSourcePill(decision);
  const refLabel = decisionRef(decision, parentDoc);
  const lines = [`- ${refLabel} ${status}${source}: "${decision.title}"`];
  if (decision.resolution) {
    lines[0] += ` → "${decision.resolution}"`;
  }
  const chose = decisionChoseLine(decision);
  if (chose) lines.push(chose);
  const options = decisionOptionsBlock(decision);
  if (options) lines.push(options);
  if (decision.context) {
    lines.push(`  Context: ${decision.context}`);
  }
  if (parentDoc) {
    const canonical = maybeChildRef(slugs, parentDoc, "decisions", decision.seq);
    lines.push(`  ref: ${canonical}`);
  }
  return lines.join("\n");
}

function formatDecisionList(
  decs: Decision[],
  parentDoc?: Doc,
  slugs?: FormatterRefContext,
): string {
  const open = decs.filter((d) => d.status === "open");
  const resolved = decs.filter((d) => d.status === "resolved");

  const lines: string[] = [];
  lines.push(
    `## Decisions (${decs.length} total: ${open.length} open, ${resolved.length} resolved)`
  );

  for (const d of decs) {
    // Pass parentDoc through so each list entry surfaces the qualified `M-N:D-M`
    // handle (t-20 W-A) when a parent doc is in scope.
    lines.push(formatDecision(d, parentDoc, slugs));
  }

  return lines.join("\n");
}

// ══════════════════════════════════════
// Tasks
// ══════════════════════════════════════

function formatCommentBadge(counts?: { open: number; resolved: number }): string {
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.open > 0) parts.push(`${counts.open} open`);
  if (counts.resolved > 0) parts.push(`${counts.resolved} resolved`);
  if (parts.length === 0) return "";
  const label = counts.open + counts.resolved === 1 ? "comment" : "comments";
  return ` [${parts.join(", ")} ${label}]`;
}

function formatTask(
  t: TaskWithBlockers,
  commentCounts?: { open: number; resolved: number },
  slugs?: FormatterRefContext,
  parentDoc?: Pick<Doc, "docType" | "handle">,
): string {
  let statusLabel: string;
  if (t.blocked) {
    const blockerNames: string[] = [];
    for (const d of t.blockedByDecisions) blockerNames.push(`dec-${d.seq}`);
    for (const w of t.blockedByTasks) blockerNames.push(`t-${w.seq}`);
    statusLabel = `BLOCKED by ${blockerNames.join(", ")}`;
  } else if (t.status === "not_started") {
    statusLabel = "READY";
  } else {
    statusLabel = t.status.toUpperCase();
  }

  const badge = formatCommentBadge(commentCounts);
  const lines = [`- t-${t.seq} [${statusLabel}]: "${t.title}"${badge}`];
  if (t.description) {
    lines.push(`  ${t.description}`);
  }
  if (t.sectionRef) {
    lines.push(`  Section: ${t.sectionRef}`);
  }
  const criteria = (t.acceptanceCriteria ?? []) as AcceptanceCriterion[];
  if (criteria.length > 0) {
    lines.push(`  Acceptance criteria:`);
    for (const c of criteria) {
      lines.push(`    ${c.done ? "[x]" : "[ ]"} ${c.description}`);
    }
  }
  if (parentDoc) {
    const canonical = maybeChildRef(slugs, parentDoc, "tasks", t.seq);
    lines.push(`  ref: ${canonical}`);
  }
  return lines.join("\n");
}

function formatTaskList(
  items: TaskWithBlockers[],
  commentCounts?: Map<string, { open: number; resolved: number }>,
  slugs?: FormatterRefContext,
  parentDoc?: Pick<Doc, "docType" | "handle">,
): string {
  const ready = items.filter((t) => !t.blocked && t.status === "not_started");
  const blocked = items.filter((t) => t.blocked);
  const inProgress = items.filter((t) => t.status === "in_progress");
  const complete = items.filter((t) => t.status === "complete");

  const lines: string[] = [];
  lines.push(
    `## Tasks (${items.length} total: ${ready.length} ready, ${blocked.length} blocked, ${inProgress.length} in progress, ${complete.length} complete)`
  );

  for (const t of items) {
    lines.push(formatTask(t, commentCounts?.get(t.id), slugs, parentDoc));
  }

  return lines.join("\n");
}

// Pre-task reminder block — prepended to formatReadyTasks so every entry into
// `build` carries the standards-first / read-before-write / honest-verification
// framing the workflow skill calls out as non-negotiable.
const READY_TASKS_PREAMBLE = [
  "**Before you start a task:**",
  "1. Re-read the Spec narrative with `get_doc(specHandle)` — resolved decisions are constraints on how you implement.",
  "2. `search_memex({ query, kind: 'standard' })` for the area you're touching. Zero results isn't a skip-signal; it's a cold-start signal — note the gap and consider `create_standard` once a pattern stabilises.",
  "3. Read existing code before writing new code (`list_symbols`, `code_search`, `get_symbol` with include:['dependencies']).",
  "",
  "A task is `complete` only when verification actually runs — type checks pass, tests pass, the new code path is exercised. Plausibility is the failure mode.",
].join("\n");

export function formatReadyTasks(
  items: Task[],
  docHandle: string,
  slugs?: FormatterRefContext,
  parentDoc?: Pick<Doc, "docType" | "handle">,
): string {
  if (items.length === 0) {
    return `# Ready Tasks\n\nNo unblocked, not-started tasks in ${docHandle}.\n\nAll tasks are either blocked, in progress, or complete.`;
  }

  const lines: string[] = [];
  lines.push(`# Ready Tasks (${items.length})`);
  lines.push("");
  lines.push(READY_TASKS_PREAMBLE);
  lines.push("");
  lines.push("These tasks are unblocked and ready to start:");
  lines.push("");

  for (const t of items) {
    const taskRef = parentDoc
      ? maybeChildRef(slugs, parentDoc, "tasks", t.seq)
      : `t-${t.seq}`;
    lines.push(`- t-${t.seq}: "${t.title}"`);
    lines.push(`  ${t.description}`);
    lines.push(
      `  → Start with \`update_task({ref: "${taskRef}", status: "in_progress"})\``,
    );
  }

  return lines.join("\n");
}

// ══════════════════════════════════════
// Phase-Aware Spec Guidance
// ══════════════════════════════════════
// For Specs, guidance is driven off lifecycle status (draft → plan → build →
// verify → done — see doc-10 / std-19 for the SDD Standard). The status-rename
// agent is widening the enum in parallel; both legacy ("review"/"implementation")
// and new ("plan"/"build"/"verify") values map onto the same phase so the right
// copy ships regardless of which lands first. Non-Spec docs and any unrecognised
// status fall back to data-shape inference.

type SpecPhase = "draft" | "plan" | "build" | "verify" | "done";

function phaseFromStatus(status: string): SpecPhase | null {
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
      return null;
  }
}

// b-68 t-7: phase static prose (intent + allowance) is now sourced from
// `BASE_SCAFFOLD.phases[phase]` rather than hand-written switch statements.
// The structured `{allowed, blocked}` arrays on the PhaseNode are the data
// form of the legacy `**Allowed now:** ... **Blocked now:** ...` line. We
// render them back into that same text shape so existing tool responses stay
// close to byte-identical for the agent.
function phaseNode(phase: SpecPhase): PhaseNode | undefined {
  return BASE_SCAFFOLD.phases.find((p) => p.phase === phase);
}

function renderAllowanceLine(phase: SpecPhase): string {
  const node = phaseNode(phase);
  if (!node) return "";
  // Done is a degenerate case: the allowance set is "read-only" — pinned
  // as a single sentence rather than a list of every read tool, matching the
  // legacy line shape ("Read-only. Spec is closed.").
  if (phase === "done") {
    return "Read-only. Spec is closed.";
  }
  // Verify is similarly compressed: the data-form lists which mutators stay
  // available, but the legacy line surfaces the human-only `done` block as
  // the load-bearing fact. Preserve that phrasing.
  if (phase === "verify") {
    return "**Allowed now:** validation + revision. **Human-only:** moving to `done`.";
  }
  // Build allowance is rendered as the legacy summary phrase rather than the
  // data-form list — the structured allowance carries the same information
  // (full task surface + sections + decisions + drift / standard-change
  // proposals) but the prose line is what the agent already expects.
  if (phase === "build") {
    return "**Allowed now:** full task surface, execution plans, `flag_drift`, `propose_standard_change`, sections, decisions.";
  }
  // Draft / plan share the same data-form allowance (decisions + sections,
  // tasks blocked). Render the structured arrays back into the canonical line
  // shape so callers see the original wording.
  const allowedList = node.allowance.allowed
    .map((name) => {
      // Decoration parity with the legacy line: create_decision is the
      // candidate-aware variant in plan/draft.
      if (name === "create_decision") return "`create_decision` (incl. status='candidate')";
      return `\`${name}\``;
    })
    .join(", ");
  // The legacy line spelled blocked tools out explicitly: "task creation
  // (`create_task`), execution plans". Pull the same phrasing from the
  // structured `blocked` set.
  const blockedLabel = (() => {
    const set = new Set(node.allowance.blocked);
    const parts: string[] = [];
    if (set.has("create_task")) parts.push("task creation (`create_task`)");
    if (set.has("execution_plans")) parts.push("execution plans");
    return parts.join(", ");
  })();
  return `**Allowed now:** ${allowedList}. **Blocked now:** ${blockedLabel}.`;
}

function renderHeaderLine(phase: SpecPhase): string {
  const node = phaseNode(phase);
  if (!node) return "";
  return `**Phase:** ${phase} — ${node.intent}`;
}

/**
 * Per dec-1 of doc-20: terse `update_doc` / `publish_spec` responses
 * include a one-line phase summary so the agent doesn't need a follow-up
 * `assess_spec` call to learn what's allowed at the new phase. Returns
 * `null` if the status isn't a Spec phase (no header to render).
 *
 * b-68 t-7: the allowance text is derived from `BASE_SCAFFOLD.phases`
 * (specifically `phaseNode(phase).allowance`) rather than hand-coded.
 */
export function formatTerseSpecPhase(status: string): string | null {
  const phase = phaseFromStatus(status);
  if (!phase) return null;
  return `Phase: ${phase}. ${renderAllowanceLine(phase).replace(/\*\*/g, "")}`;
}

/**
 * spec-121 mechanism 1 — the build-phase uncovered-AC nag footer.
 *
 * Pure: given a Spec handle and its ACs (with derived verification state),
 * returns the footer naming every AC that is `untested` or `failing`, split
 * into two labelled groups with their own remediation verb. Returns "" when no
 * AC needs attention — i.e. all ACs are `verified` or `stale` (dec-3: only a
 * passing test clears the nag; `stale` counts as covered-and-passing).
 *
 * Covers BOTH scope and implementation ACs (dec-4). The static prose comes
 * from `BUILD_AC_NAG_PROSE` in the Scaffold (dec-2); only the dynamic grouping
 * and ref interpolation happen here.
 */
export function renderAcNagFooter(
  specHandle: string,
  acs: AcWithVerification[],
): string {
  const untested = acs.filter((a) => a.verificationState === "untested");
  const failing = acs.filter((a) => a.verificationState === "failing");
  if (untested.length === 0 && failing.length === 0) return "";

  const handles = (rows: AcWithVerification[]): string =>
    rows.map((r) => `ac-${r.ac.seq}`).join(" ");

  const lines: string[] = [
    BUILD_AC_NAG_PROSE.heading(specHandle, untested.length + failing.length),
  ];
  if (untested.length > 0) {
    lines.push(
      `  ${BUILD_AC_NAG_PROSE.untestedLabel} (${untested.length}): ${handles(untested)}`,
    );
    lines.push(
      `    ${BUILD_AC_NAG_PROSE.untestedInstruction} ${BUILD_AC_NAG_PROSE.tagAcCall(untested[0].canonicalRef)}`,
    );
  }
  if (failing.length > 0) {
    lines.push(
      `  ${BUILD_AC_NAG_PROSE.failingLabel} (${failing.length}): ${handles(failing)}`,
    );
    lines.push(`    ${BUILD_AC_NAG_PROSE.failingInstruction}`);
  }
  return lines.join("\n");
}

function formatSpecGuidance(
  doc: Doc,
  decs: Decision[],
  tasksList: TaskWithBlockers[],
  nudge?: NudgeContext,
  acVerifications?: AcWithVerification[],
): string {
  if (doc.docType === "spec") {
    const phase = phaseFromStatus(doc.status);
    if (phase)
      return renderSpecPhaseGuidance(doc, phase, decs, tasksList, nudge, acVerifications);
  }
  return formatLegacyDataShapeGuidance(doc, decs, tasksList);
}

/**
 * b-68 t-7: the phase guidance footer appended to Spec doc responses.
 * Composed from `toNudge({ dataset: BASE_SCAFFOLD, tool, phase, orgBlocks })`
 * for the static prose (phase header, allowance, per-phase footer,
 * behavioural blocks, code-grounding nudge, standards protocol) plus
 * dynamic per-Spec counts (open decisions, ready / in-progress / blocked
 * tasks) rendered from `decs` and `tasksList`.
 *
 * Replaces the previous switch-statement that hand-composed the phase
 * header, the allowance line, and a per-phase `mcp-footer.md` read. The
 * toNudge projection now owns ALL static prose for the nudge channel;
 * phase-targeted Org additions (b-68 t-3) join the composition with no
 * further code changes.
 */
function renderSpecPhaseGuidance(
  doc: Doc,
  phase: SpecPhase,
  decs: Decision[],
  tasksList: TaskWithBlockers[],
  nudge?: NudgeContext,
  acVerifications?: AcWithVerification[],
): string {
  const lines: string[] = ["---"];
  const openDecs = decs.filter((d) => d.status === "open");
  const resolvedDecs = decs.filter((d) => d.status === "resolved");
  const ready = tasksList.filter((t) => !t.blocked && t.status === "not_started");
  const blocked = tasksList.filter((t) => t.blocked);
  const inProgress = tasksList.filter((t) => t.status === "in_progress");

  // Static prose — composed by `toNudge`. The projection emits the global
  // shared-nudge blocks (about-spec, mutation-protocol, code-grounding,
  // standards-protocol) followed by phase-targeted blocks (phase header at
  // order:0, allowance at order:1, mcp-footer at order:2, behavioural blocks
  // at order:10-13). Phase-targeted Org additions (b-68 t-3) interleave
  // automatically because they share `target: { phase }` shape.
  const nudgeText = toNudge({
    dataset: BASE_SCAFFOLD,
    tool: nudge?.tool,
    phase,
    orgBlocks: nudge?.orgBlocks,
  });
  if (nudgeText.length > 0) {
    lines.push(nudgeText);
  }

  // Dynamic per-Spec counts — stay in code because they're derived from the
  // current doc snapshot, not from the static scaffold.
  switch (phase) {
    case "draft":
    case "plan": {
      lines.push("");
      if (openDecs.length > 0) {
        lines.push(
          `**${openDecs.length} open decision${openDecs.length === 1 ? "" : "s"} to resolve before \`build\`:**`,
        );
        for (const d of openDecs) {
          lines.push(`- D-${d.seq}: "${d.title}"`);
          if (d.context) lines.push(`  ${d.context}`);
          lines.push(
            `  → \`resolve_decision({ref: "<dec-ref>", resolution: "your resolution"})\``,
          );
        }
        lines.push("");
      }

      if (resolvedDecs.length > 0) {
        lines.push(
          `**Recently resolved:** ${resolvedDecs.length} decision${resolvedDecs.length === 1 ? "" : "s"}. ` +
            "Make sure each is reflected in the Spec narrative — use `update_section` on the affected sections before moving on.",
        );
        lines.push("");
      }

      if (openDecs.length === 0 && decs.length > 0) {
        lines.push(
          "All decisions resolved. Once the narrative reflects them, advance to `build`:",
        );
        lines.push("```");
        lines.push(`update_doc({ref: "<doc-ref>", status: "build"})`);
        lines.push("```");
      } else if (decs.length === 0) {
        lines.push(
          "No decisions yet. Either there are none to make (advance to `build`), or the Spec needs a closer read to surface choices that have been hand-waved. " +
            "**For brand-new work** where the right choices only emerge through prototyping, advance to `build` with explicit build-to-learn intent — capture decisions when they appear and step back to `plan` to settle them.",
        );
      }
      return lines.join("\n");
    }

    case "build": {
      lines.push("");
      if (openDecs.length > 0) {
        lines.push(
          `⚠ **${openDecs.length} open decision${openDecs.length === 1 ? "" : "s"} on this Spec.** ` +
            "New decisions surfacing in `build` is normal but each must be resolved before any task it blocks proceeds:",
        );
        for (const d of openDecs) {
          lines.push(
            `- D-${d.seq}: "${d.title}" → \`resolve_decision({ref: "<dec-ref>", resolution: "resolution"})\``,
          );
        }
        lines.push("");
      }

      if (ready.length > 0) {
        lines.push(`**${ready.length} task${ready.length === 1 ? "" : "s"} ready to start:**`);
        for (const t of ready) {
          lines.push(
            `- T-${t.seq}: "${t.title}" → \`update_task({ref: "<task-ref>", status: "in_progress"})\``,
          );
        }
        lines.push("");
      }

      if (inProgress.length > 0) {
        lines.push(`**${inProgress.length} in progress:**`);
        for (const t of inProgress) {
          lines.push(
            `- T-${t.seq}: "${t.title}" → \`update_task({ref: "<task-ref>", status: "complete"})\` when done`,
          );
        }
        lines.push("");
      }

      if (blocked.length > 0) {
        lines.push(
          `**${blocked.length} blocked** — resolve their dependencies to unblock.`,
        );
        lines.push("");
      }

      if (
        ready.length === 0 &&
        inProgress.length === 0 &&
        blocked.length === 0 &&
        tasksList.length > 0
      ) {
        lines.push("All tasks complete. Move to `verify` for acceptance:");
        lines.push("```");
        lines.push(`update_doc({ref: "<doc-ref>", status: "verify"})`);
        lines.push("```");
      }

      // spec-121 mechanism 1 — the uncovered-AC nag. Sits at the foot of the
      // build guidance (below the task list), never above the tool's payload.
      // Dynamic per-Spec lookup (dec-2): the AC states arrive pre-computed from
      // the caller's live query; the prose comes from the Scaffold.
      if (acVerifications && acVerifications.length > 0) {
        const nag = renderAcNagFooter(doc.handle, acVerifications);
        if (nag.length > 0) {
          lines.push("");
          lines.push(nag);
        }
      }
      return lines.join("\n");
    }

    case "verify":
    case "done": {
      return lines.join("\n");
    }
  }
}

// Legacy data-shape inference. Used for non-Spec docTypes (free-form
// documents, execution-plans) and as a fallback when a Spec status isn't
// recognised. Predates the lifecycle rename and reasons from decisions/tasks
// shape rather than doc.status.
function formatLegacyDataShapeGuidance(
  doc: Doc,
  decs: Decision[],
  tasksList: TaskWithBlockers[]
): string {
  const lines: string[] = [];
  lines.push("---");

  const openDecs = decs.filter((d) => d.status === "open");
  const resolvedDecs = decs.filter((d) => d.status === "resolved");
  const hasDecisions = decs.length > 0;
  const hasTasks = tasksList.length > 0;
  const allDecisionsResolved = hasDecisions && openDecs.length === 0;

  // Phase 1 — DRAFTING: no decisions yet
  if (!hasDecisions && !hasTasks) {
    lines.push("## Next: Identify Decisions");
    lines.push("");
    lines.push(
      `This ${doc.docType} has no decisions yet. Analyse the document and identify the key choices ` +
      "that need to be made before work can begin. Decisions are gates — they force deliberation " +
      "before execution and prevent agents from charging ahead on assumptions."
    );
    lines.push("");
    lines.push("Create decisions with context explaining the options and trade-offs:");
    lines.push("```");
    lines.push(`create_decision({ref: "<doc-ref>", title: "The question?", context: "Context: Option A does X. Option B does Y. Trade-off is..."})`);
    lines.push("```");
    lines.push("");
    lines.push("Or pass decisions when creating the document:");
    lines.push("```");
    lines.push(`create_doc({title, purpose, docType: "${doc.docType}", decisions: [{title: "...", context: "..."}]})`);
    lines.push("```");
    return lines.join("\n");
  }

  // Phase 2 — DECIDING: decisions exist, some/all open, no tasks
  if (hasDecisions && openDecs.length > 0 && !hasTasks) {
    // If there are recently resolved decisions, the immediate action is to update the document
    if (resolvedDecs.length > 0) {
      lines.push(`## ACTION REQUIRED: Update the ${doc.docType}`);
      lines.push("");
      lines.push(
        `${resolvedDecs.length} decision${resolvedDecs.length > 1 ? "s have" : " has"} been resolved. ` +
        `**You must now update the ${doc.docType} to reflect ${resolvedDecs.length === 1 ? "this decision" : "these decisions"} before continuing.** ` +
        `The ${doc.docType} is the source of truth — if a decision isn't reflected in the document, ` +
        "it hasn't truly been made."
      );
      lines.push("");
      lines.push("For each resolved decision, identify which sections are affected and update them:");
      for (const d of resolvedDecs) {
        lines.push(`- D-${d.seq}: "${d.title}" → resolved: "${d.resolution}"`);
      }
      lines.push("");
      lines.push("Use `update_section({ref: '<section-ref>', content: '...'})` to incorporate each decision into the relevant sections.");
      lines.push("Review the sections above and update any that reference or are affected by these decisions.");
      lines.push("");
      lines.push("---");
      lines.push("");
    }

    lines.push(`## Remaining: ${openDecs.length} Open Decision${openDecs.length > 1 ? "s" : ""}`);
    lines.push("");
    lines.push(
      "Resolve these before creating tasks — tasks should be informed by decisions, not created in parallel."
    );
    lines.push("");
    for (const d of openDecs) {
      lines.push(`- D-${d.seq}: "${d.title}"`);
      if (d.context) lines.push(`  ${d.context}`);
      lines.push(`  → \`resolve_decision({ref: "<dec-ref>", resolution: "your resolution"})\``);
    }
    return lines.join("\n");
  }

  // Phase 3 — PLANNING: decisions resolved (or mostly), no/few tasks
  if (allDecisionsResolved && !hasTasks) {
    lines.push(`## ACTION REQUIRED: Update the ${doc.docType} Before Creating Tasks`);
    lines.push("");
    lines.push(
      `All decisions are resolved. **Do not create tasks yet.** First, update the ${doc.docType} ` +
      "to reflect every resolved decision:"
    );
    lines.push("");
    for (const d of resolvedDecs) {
      lines.push(`- D-${d.seq}: "${d.title}" → "${d.resolution}"`);
    }
    lines.push("");
    lines.push(
      "Go through each section above and update it to incorporate these decisions. " +
      "The approach, scope, architecture, and any other affected sections must reflect " +
      "the choices made. Use `update_section({ref: '<section-ref>', content: '...'})` for each affected section."
    );
    lines.push("");
    lines.push(
      `**Only after the ${doc.docType} is fully up to date**, create tasks with acceptance criteria:`
    );
    lines.push("```");
    lines.push(`create_task({ref: "<doc-ref>", title: "Title", description: "Description", acceptanceCriteria: [{description: "criterion", done: false}], sectionRef: "section_type"})`);
    lines.push("```");
    return lines.join("\n");
  }

  // Phase 4 — EXECUTING: tasks exist
  if (hasTasks) {
    const ready = tasksList.filter((t) => !t.blocked && t.status === "not_started");
    const blocked = tasksList.filter((t) => t.blocked);
    const inProgress = tasksList.filter((t) => t.status === "in_progress");

    lines.push("## Status & Next Steps");
    lines.push("");

    if (openDecs.length > 0) {
      lines.push(
        `**${openDecs.length} open decision${openDecs.length > 1 ? "s" : ""}** still blocking work:`
      );
      for (const d of openDecs) {
        lines.push(`- D-${d.seq}: "${d.title}" → \`resolve_decision({ref: "<dec-ref>", resolution: "resolution"})\``);
      }
      lines.push("");
      lines.push(
        `**ACTION REQUIRED after resolving:** Immediately update the ${doc.docType} sections to reflect each decision. ` +
        `Do not continue to the next decision or task until the ${doc.docType} reflects the choice. ` +
        "Use `update_section({ref: '<section-ref>', content: '...'})` on every affected section."
      );
      lines.push("");
    }

    if (ready.length > 0) {
      lines.push(`**${ready.length} task${ready.length > 1 ? "s" : ""} ready to start:**`);
      for (const t of ready) {
        lines.push(`- T-${t.seq}: "${t.title}" → \`update_task({ref: "<task-ref>", status: "in_progress"})\``);
      }
      lines.push("");
    }

    if (inProgress.length > 0) {
      lines.push(`**${inProgress.length} in progress:**`);
      for (const t of inProgress) {
        lines.push(`- T-${t.seq}: "${t.title}" → \`update_task({ref: "<task-ref>", status: "complete"})\` when done`);
      }
      lines.push("");
    }

    if (blocked.length > 0) {
      lines.push(`**${blocked.length} blocked** — resolve their dependencies to unblock.`);
      lines.push("");
    }

    if (ready.length === 0 && inProgress.length === 0 && blocked.length === 0) {
      lines.push("All tasks are complete.");
    }

    return lines.join("\n");
  }

  // Fallback — mixed state (some decisions open, some tasks)
  lines.push("## Tools");
  lines.push("");
  lines.push('- `resolve_decision({ref, resolution})` — resolve a decision');
  lines.push('- `create_task({ref, title, description, acceptanceCriteria?, sectionRef?})` — add work');
  lines.push('- `update_task({ref, status})` — "in_progress" or "complete"');
  lines.push('- `update_task({ref, addBlockerRef})` — wire dependencies');
  lines.push('- `list_tasks({ref, readyOnly: true})` — find what\'s unblocked');
  return lines.join("\n");
}

// ══════════════════════════════════════
// Spec formatters (t-6 / doc-10 Slice 1)
// ══════════════════════════════════════
// Spec-specific output for the Specs MCP slice. They reuse the existing doc-list
// shape but lead with Spec phrasing, and the status formatter highlights progress
// counts plus lineage rather than dumping the full content body.

export function formatSpecList(
  specs: DocSummary[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push(`# Specs (${specs.length})`);
  lines.push("");

  if (specs.length === 0) {
    lines.push("No Specs in this Memex yet. Create one with `create_doc(title, purpose, docType: 'spec')`.");
    return lines.join("\n").trimEnd();
  }

  for (const s of specs) {
    const url = appBaseUrl ? `\n  URL: ${docUrl(appBaseUrl, s.docType, s.handle)}` : "";
    const lineage = s.parentDocId ? `, promoted from ${s.parentDocId}` : "";
    lines.push(
      `- **${s.title}** (${s.handle}) [${s.status.toUpperCase()}] — ${s.sectionCount} sections, created ${formatDate(s.createdAt)}, status changed ${formatDate(s.statusChangedAt)}${lineage}\n  ref: ${maybeDocRef(slugs, s)}${url}`,
    );
  }

  lines.push("");
  lines.push(
    "Pick one and call `get_doc({ref})` — its phase determines what's allowed: `draft`/`plan` is decisions only, `build` opens up tasks, `verify` is acceptance, `done` is read-only.",
  );

  return lines.join("\n").trimEnd();
}

export function formatSpecStatus(
  doc: Doc,
  decisions: Decision[],
  tasks: TaskWithBlockers[],
  lineage: Doc[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push(`# ${doc.title} [${doc.status.toUpperCase()}]`);
  lines.push(`Spec | ref: ${maybeDocRef(slugs, doc)} | Handle: ${doc.handle}`);
  lines.push(`Status: ${doc.status} (changed ${formatDate(doc.statusChangedAt)})`);
  if (appBaseUrl) {
    lines.push(`URL: ${docUrl(appBaseUrl, doc.docType, doc.handle)}`);
  }
  lines.push("");

  // Phase block — leads with current phase + intent + allowed/blocked tooling,
  // plus the outstanding-decisions hint when in plan. Reinforces the gate on
  // every read.
  const specPhase = phaseFromStatus(doc.status);
  if (specPhase) {
    const openDecsForPhase = decisions.filter((d) => d.status === "open");
    lines.push(renderHeaderLine(specPhase));
    lines.push(renderAllowanceLine(specPhase));
    if (specPhase === "plan" && openDecsForPhase.length > 0) {
      lines.push("");
      lines.push(
        `Open decisions to resolve before \`build\`: ${openDecsForPhase.map((d) => `D-${d.seq}`).join(", ")}`,
      );
    }
    lines.push("");
  }

  if (lineage.length > 1) {
    lines.push("## Lineage");
    const trail = lineage
      .map((d) => (d.id === doc.id ? `**${d.handle}**` : d.handle))
      .join(" → ");
    lines.push(trail);
    lines.push("");
  }

  const open = decisions.filter((d) => d.status === "open");
  const resolved = decisions.filter((d) => d.status === "resolved");
  const candidate = decisions.filter((d) => d.status === "candidate");
  const rejected = decisions.filter((d) => d.status === "rejected");
  lines.push(
    `## Decisions (${decisions.length}): ${open.length} open · ${resolved.length} resolved · ${candidate.length} candidate · ${rejected.length} rejected`,
  );
  for (const d of open) {
    lines.push(`- dec-${d.seq} [OPEN]: ${d.title}`);
  }
  for (const d of candidate) {
    lines.push(`- dec-${d.seq} [CANDIDATE]: ${d.title}`);
  }
  lines.push("");

  const ready = tasks.filter((w) => !w.blocked && w.status === "not_started");
  const blocked = tasks.filter((w) => w.blocked);
  const inProgress = tasks.filter((w) => w.status === "in_progress");
  const complete = tasks.filter((w) => w.status === "complete");
  lines.push(
    `## Tasks (${tasks.length}): ${ready.length} ready · ${blocked.length} blocked · ${inProgress.length} in progress · ${complete.length} complete`,
  );
  for (const w of inProgress) {
    lines.push(`- t-${w.seq} [IN PROGRESS]: ${w.title}`);
  }
  for (const w of ready) {
    lines.push(`- t-${w.seq} [READY]: ${w.title}`);
  }
  for (const w of blocked) {
    const blockers: string[] = [];
    for (const d of w.blockedByDecisions) blockers.push(`dec-${d.seq}`);
    for (const x of w.blockedByTasks) blockers.push(`t-${x.seq}`);
    lines.push(`- t-${w.seq} [BLOCKED by ${blockers.join(", ")}]: ${w.title}`);
  }

  return lines.join("\n").trimEnd();
}

export function formatPromotedSpec(
  child: Doc & { sections: DocSection[] },
  source: Doc,
  task: Task,
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push(`# Promoted t-${task.seq} → new Spec ${child.handle}`);
  lines.push("");
  lines.push(`Source Spec: **${source.title}** (${source.handle})`);
  lines.push(`Promoted task: t-${task.seq} — "${task.title}" (still in ${source.handle})`);
  lines.push(`New Spec: **${child.title}** (${child.handle}) [${child.status.toUpperCase()}]`);
  lines.push(`Lineage: ${source.handle} → ${child.handle}`);
  if (slugs) {
    lines.push(`ref: ${maybeDocRef(slugs, child)}`);
  }
  if (appBaseUrl) {
    lines.push(`URL: ${docUrl(appBaseUrl, child.docType, child.handle)}`);
  }
  lines.push("");
  const childRef = maybeDocRef(slugs, child);
  lines.push(
    `Next: surface the new Spec's decisions with \`create_decision({ref: "${childRef}", ...})\` and scope work via \`create_task({ref: "${childRef}", ...})\`.`,
  );
  return lines.join("\n").trimEnd();
}

// ══════════════════════════════════════
// Execution plan formatters (t-7 / doc-10 Slice 2)
// ══════════════════════════════════════

export function formatExecutionPlan(
  plan: ExecutionPlan,
  task: Task,
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push(`# Execution plan for t-${task.seq}: ${task.title}`);
  lines.push(`Plan: ${plan.title} (${plan.handle}) [${plan.status.toUpperCase()}]`);
  lines.push(`ref: ${maybeDocRef(slugs, plan)}`);
  if (appBaseUrl) {
    lines.push(`URL: ${docUrl(appBaseUrl, plan.docType, plan.handle)}`);
  }
  lines.push("");

  for (const section of plan.sections) {
    lines.push(`## ${section.title ?? section.sectionType}`);
    lines.push(section.content || "_(empty)_");
    lines.push("");
    lines.push(`Section ref: ${maybeChildRef(slugs, plan, "sections", section.seq)} | Type: ${section.sectionType}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "After submission, post a `readiness_check` typed comment with READY/NOT READY assessment using `add_comment({ref: \"<task-ref>\", type: \"readiness_check\", ...})`.",
  );

  return lines.join("\n").trimEnd();
}

export function formatDependentExecutionPlans(
  spec: Doc,
  plans: ExecutionPlan[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push(`# Execution plans dependent on ${spec.handle}`);
  lines.push(`Spec: ${spec.title}`);
  lines.push("");

  if (plans.length === 0) {
    lines.push("No tasks in this Spec have a linked execution plan yet.");
    return lines.join("\n").trimEnd();
  }

  lines.push(`${plans.length} plan${plans.length === 1 ? "" : "s"} found:`);
  for (const plan of plans) {
    const url = appBaseUrl ? ` — ${docUrl(appBaseUrl, plan.docType, plan.handle)}` : "";
    lines.push(
      `- **${plan.title}** (${plan.handle}) [${plan.status.toUpperCase()}] — ${plan.sections.length} sections${url}\n  ref: ${maybeDocRef(slugs, plan)}`,
    );
  }

  return lines.join("\n").trimEnd();
}

// ══════════════════════════════════════
// Decision extraction formatters (t-9 / doc-10 Slice 3)
// ══════════════════════════════════════

function formatOption(option: DecisionOption, idx: number, chosen: number | null): string {
  const marker = chosen === idx ? " ← CHOSEN" : "";
  return `  ${idx}. **${option.label}**${marker}\n     Trade-offs: ${option.trade_offs || "_(none)_"}`;
}

export function formatDecisionImpact(
  decision: Decision,
  parentDoc: Doc,
  blockedTasks: Task[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  // Qualified handle is the canonical reference once a parent doc is in scope (t-20 W-A);
  // source pill surfaces agent-proposed decisions distinctly (t-20 W-C).
  const qualified = `${parentDoc.handle}:dec-${decision.seq}`;
  const sourcePill = decision.source === "agent" ? " [AGENT]" : "";
  lines.push(`# Impact: ${qualified} [${decision.status.toUpperCase()}]${sourcePill}`);
  lines.push(`"${decision.title}"`);
  lines.push(`ref: ${maybeChildRef(slugs, parentDoc, "decisions", decision.seq)}`);
  lines.push(`On Spec: ${parentDoc.title} (${parentDoc.handle})`);
  if (appBaseUrl) {
    lines.push(`URL: ${docUrl(appBaseUrl, parentDoc.docType, parentDoc.handle)}`);
  }
  lines.push("");

  if (decision.context) {
    lines.push("## Context");
    lines.push(decision.context);
    lines.push("");
  }

  const options = (decision.options as DecisionOption[] | null) ?? [];
  if (options.length > 0) {
    lines.push(`## Options (${options.length})`);
    options.forEach((o, idx) => {
      lines.push(formatOption(o, idx, decision.chosenOptionIndex));
    });
    lines.push("");
  }

  if (decision.resolution) {
    lines.push("## Resolution");
    lines.push(decision.resolution);
    lines.push("");
  }

  lines.push(`## Blocked tasks (${blockedTasks.length})`);
  if (blockedTasks.length === 0) {
    lines.push("No tasks are currently blocked by this decision.");
  } else {
    for (const w of blockedTasks) {
      lines.push(`- t-${w.seq} [${w.status.toUpperCase()}]: ${w.title}`);
      lines.push(`  ref: ${maybeChildRef(slugs, parentDoc, "tasks", w.seq)}`);
    }
  }

  return lines.join("\n").trimEnd();
}

// ══════════════════════════════════════
// Standard formatters (t-10 / doc-10 Slice 4 + t-7/t-9 of doc-8)
// ══════════════════════════════════════
//
// Every read-side standards response (list_docs, get_doc, search_memex)
// ends with the same protocol footer so any agent reading a standard knows the
// expected interaction loop:
//
//   1. If the rule is wrong, propose a change via `propose_standard_change`.
//   2. If the rule is fine but the codebase has drifted from it, post a
//      `flag_drift` so the standard owner sees it in the Drift Inbox.
//   3. When citing a standard inline, use the `[per std-N]` form so the
//      back-link can be resolved later.
//
// Centralising this string is what gives us "the agent always knows the
// protocol" without coupling every caller to a magic-string convention.

// b-33 follow-up: content lives in `phases/_base/standards-protocol.md`,
// loaded once at module init via the same `readPhaseFile` helper used by the
// per-phase footers. `_base/` is the home for cross-phase invariants
// (consistent with `role.md`, `mdx-components.md`, etc.). The exported symbol
// name is preserved so downstream importers keep working.
export const STANDARDS_PROTOCOL_FOOTER = readPhaseFile("_base", "standards-protocol.md");

function withStandardsProtocolFooter(body: string): string {
  return `${body}\n${STANDARDS_PROTOCOL_FOOTER}`;
}



export function formatStandardList(
  entries: StandardListEntry[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push("# Standards");
  lines.push("");

  if (entries.length === 0) {
    lines.push("No standards in this Memex yet.");
    return lines.join("\n").trimEnd();
  }

  for (const e of entries) {
    const url = appBaseUrl ? `\n  URL: ${docUrl(appBaseUrl, "standard", e.handle)}` : "";
    const driftTag = e.driftCount > 0 ? ` · ${e.driftCount} open drift` : "";
    const ref = maybeDocRef(slugs, { docType: "standard", handle: e.handle });
    lines.push(
      `- **${e.title}** (${e.handle}) [${e.status.toUpperCase()}] — ${e.sectionCount} sections${driftTag}, created ${formatDate(e.createdAt)}\n  ref: ${ref}${url}`,
    );
  }

  lines.push("");
  lines.push(`${entries.length} standard${entries.length === 1 ? "" : "s"} total`);
  return withStandardsProtocolFooter(lines.join("\n").trimEnd());
}

// spec-161: render a standard section's body as its clauses, each prefixed with its
// short `cl-N` handle (N = allocate-once seq). The handle gives the agent citation +
// edit targets at near-zero token cost; the canonical clause prefix is never repeated
// (the doc header establishes it once). A clause-less / not-yet-migrated section falls
// back to its raw content.
export function renderStandardSectionBody(
  content: string,
  clauses: { seq: number; body: string; position: number }[],
): string {
  if (clauses.length === 0) return content;
  return [...clauses]
    .sort((a, b) => a.position - b.position)
    .map((c) => `[cl-${c.seq}] ${c.body}`)
    .join("\n\n");
}

export function formatStandard(
  standard: StandardWithSections,
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];
  lines.push(`# ${standard.title} [${standard.status.toUpperCase()}]`);
  lines.push(
    `Type: Standard | ref: ${maybeDocRef(slugs, { docType: "standard", handle: standard.handle })} | Handle: ${standard.handle}`,
  );
  lines.push(
    `Status: ${standard.status} (changed ${formatDate(standard.statusChangedAt)})`,
  );
  if (standard.driftCount > 0) {
    lines.push(`Open drift findings: ${standard.driftCount}`);
  }
  if (appBaseUrl) {
    lines.push(`URL: ${docUrl(appBaseUrl, "standard", standard.handle)}`);
  }
  lines.push("");

  for (let i = 0; i < standard.sections.length; i++) {
    const s = standard.sections[i];
    const num = i + 1;
    lines.push(`## ${num}. ${s.title ?? s.sectionType}`);
    lines.push(renderStandardSectionBody(s.content, standard.clauses.filter((c) => c.sectionId === s.id)));
    lines.push("");
    lines.push(
      `Section #${num} | ref: ${maybeChildRef(slugs, { docType: "standard", handle: standard.handle }, "sections", s.seq)} | Type: ${s.sectionType}`,
    );
    lines.push("");
  }

  return withStandardsProtocolFooter(lines.join("\n").trimEnd());
}

// Exported but no caller today; drift flags are surfaced via formatComment in typed-comment threads. Tracked on doc-10 deferral list (item #5).
export function formatDriftFlags(
  comments: DocComment[],
  context: { docTitle: string; docHandle: string },
  slugs?: FormatterRefContext,
  parentDoc?: Pick<Doc, "docType" | "handle">,
): string {
  const lines: string[] = [];
  lines.push(`# Drift findings on ${context.docTitle} (${context.docHandle})`);
  lines.push("");

  if (comments.length === 0) {
    lines.push("No drift comments on this standard.");
    return lines.join("\n").trimEnd();
  }

  for (const c of comments) {
    const status = c.resolvedAt ? "resolved" : "open";
    lines.push(`- [${status}] by ${c.authorName} (source=${c.source ?? "human"})`);
    lines.push(`  ${c.content}`);
    if (parentDoc) {
      lines.push(`  ref: ${maybeChildRef(slugs, parentDoc, "comments", c.seq)}`);
    }
  }
  return lines.join("\n").trimEnd();
}

export function formatAffectedStandards(
  decisionHandle: string,
  matches: AffectedStandardMatch[],
  appBaseUrl?: string,
  slugs?: FormatterRefContext,
): string {
  const lines: string[] = [];

  if (matches.length === 0) {
    lines.push(
      `No standard sections in this Memex contain a [per ${decisionHandle}] reference.`,
    );
    return lines.join("\n").trimEnd();
  }

  lines.push(`# Standards referencing ${decisionHandle}`);
  lines.push("");
  for (const m of matches) {
    const url = appBaseUrl ? ` — ${docUrl(appBaseUrl, "standard", m.standard.handle)}` : "";
    lines.push(`- **${m.standard.title}** (${m.standard.handle})${url}`);
    for (const s of m.matchingSections) {
      lines.push(
        `  - section ${s.title ?? s.sectionType} (ref: ${maybeChildRef(slugs, { docType: "standard", handle: m.standard.handle }, "sections", s.seq)})`,
      );
    }
  }
  lines.push("");
  lines.push(
    `${matches.length} standard${matches.length === 1 ? "" : "s"} affected.`,
  );
  return withStandardsProtocolFooter(lines.join("\n").trimEnd());
}

// formatStandardsSearch removed by b-34 — its only live caller was the
// commented-out `search_standards` MCP spec, which is replaced wholesale by
// `search_memex`. The new `searchMemex()` core in
// services/memex-search.ts exports its own `formatSearchResults` helper
// aligned with b-34 D-4 (path-as-heading, no UUIDs) and b-36 D-7/D-8 (ref:).
