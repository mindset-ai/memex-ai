// spec-546: Load a doc's full state from the database and render it for a tool response.
// The single funnel every doc-rendering tool goes through — response-budget-funnel
// (spec-538 ac-16) exists to keep it the only route to formatFullDocState.
//
// Split out of agent/handlers/shared.ts (renamed tool-contract.ts in t-3)
// [per std-51: a module is named for its contents, never for the act that made it].

import {
  getDoc,
} from "../../services/documents.js";
import {
  listCommentsForDoc,
} from "../../services/comments.js";
import {
  listDecisions,
} from "../../services/decisions.js";
import {
  listTasks,
} from "../../services/tasks.js";
import { facetKeysByTask, facetKeysByDecision } from "../../services/facet-ballot.js";
import {
  listDocTags,
} from "../../services/tags.js";
import {
  formatFullDocState,
  type InjectedBlock,
} from "../../formatting/formatters.js";
import type { ToolCtx } from "./tool-contract.js";

export interface FullDocState {
  doc: Awaited<ReturnType<typeof getDoc>>;
  // spec-445 dec-2 — each decision/task carries its stored true facet keys, surfaced on
  // the read (get_doc) as context.
  decs: (Awaited<ReturnType<typeof listDecisions>>[number] & { facets?: string[] })[];
  tasks: (Awaited<ReturnType<typeof listTasks>>[number] & { facets?: string[] })[];
  comments: Awaited<ReturnType<typeof listCommentsForDoc>>;
  // spec-136 t-4: the Spec's tags, rendered inline by formatFullDocState so any
  // doc-state response (get_doc, every mutation) carries them.
  tags: Awaited<ReturnType<typeof listDocTags>>;
}

export async function fullDocState(memexId: string, docIdOrHandle: string): Promise<FullDocState> {
  const doc = await getDoc(memexId, docIdOrHandle);
  const [decs, tasksList, comments, docTags] = await Promise.all([
    listDecisions(memexId, doc.id),
    listTasks(memexId, doc.id),
    listCommentsForDoc(memexId, doc.id),
    listDocTags(memexId, doc.id),
  ]);
  // spec-445 dec-2 — attach each decision's/task's stored true facet keys so get_doc
  // surfaces the classification as context (batched; a task/decision with no ballot gets []).
  const [decFacets, taskFacets] = await Promise.all([
    facetKeysByDecision(memexId, decs.map((d) => d.id)),
    facetKeysByTask(memexId, tasksList.map((t) => t.id)),
  ]);
  const decsWithFacets = decs.map((d) => ({ ...d, facets: decFacets.get(d.id) ?? [] }));
  const tasksWithFacets = tasksList.map((t) => ({ ...t, facets: taskFacets.get(t.id) ?? [] }));
  return { doc, decs: decsWithFacets, tasks: tasksWithFacets, comments, tags: docTags };
}

/**
 * Format the full doc state for a tool response. Pass `ctx` so the
 * spec phase footer (composed by `toNudge` inside
 * `formatBriefGuidance`) picks up the per-call tool name and the
 * principal's Org-overlay blocks — both surfaces (MCP + React) thread the
 * same context here, which keeps the nudge channel a single composer per
 * b-68 dec-9 (ac-29).
 *
 * `ctx` is optional only for backwards-compatible callers (tests, ad-hoc
 * usage) — production tool dispatch ALWAYS supplies it. When absent, the
 * nudge composes against base data only (tool + orgBlocks are undefined).
 */
export async function formatState(
  baseUrl: string,
  state: FullDocState,
  ctx?: ToolCtx,
  // spec-203 dec-3 (t-3): tool-injected guidance blocks (coverage header, tag
  // summary, nudges). Tools report these instead of concatenating around the
  // call; the composer places them by zone. Absent for the many bare callers.
  blocks?: readonly InjectedBlock[],
): Promise<string> {
  // spec-203 ac-15: formatState renders only the doc BODY (+ tool-injected
  // header/footer blocks). The machine footer is no longer composed here — the
  // single seat `decideFooter` composes and attaches it at the one choke point
  // (`runToolWithSpecTraffic`) on EVERY Spec-resolving call. `ctx` is retained
  // for signature stability (callers pass it); the footer no longer reads it.
  void ctx;
  return formatFullDocState(
    state.doc,
    state.decs,
    state.tasks,
    baseUrl,
    state.comments,
    undefined,
    undefined,
    undefined,
    // spec-136 t-4: the Spec's tags, rendered as a one-line strip in the header.
    state.tags,
    // spec-203 dec-3 (t-3): tool-injected guidance, placed by the composer.
    blocks,
  );
}
