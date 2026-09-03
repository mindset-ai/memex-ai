// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
import { boundRenderedList } from "../../mcp/response-budget.js";
import { formatResolvedChild } from "../../formatting/formatters.js";
import {
  buildChildRef,
  buildDocRef,
  memexSlugsById,
} from "../../mcp/refs.js";
import {
  createDocDraft,
  listDocs,
  decisionCountsByDoc,
  taskCountsByDoc,
  getDoc,
  updateDocStatus,
  updateDocTitle,
  DOC_STATUSES,
  promoteToSpec,
} from "../../services/documents.js";
import { successorHandlesByDoc } from "../../services/supersession.js";
import {
  listDecisions,
} from "../../services/decisions.js";
import {
  listTopics,
  fetchTopic,
} from "../../services/guidance.js";
import {
  listTasks,
  getTask,
} from "../../services/tasks.js";
import {
  markIssuePromoted,
} from "../../services/issues.js";
import {
  applyTagString,
  removeTagString,
  listDocTags,
  parseTagInput,
  formatTag,
  type ParsedTag,
} from "../../services/tags.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  formatSpecList,
  formatPromotedSpec,
  formatStandard,
  renderStandardSectionBody,
  formatTerseSpecPhase,
} from "../../formatting/formatters.js";
import {
  getStandard,
} from "../../services/standards.js";
import {
  formatSkillCatalogueAppendix,
} from "../../services/skills/skill-catalogue.js";
import {
  buildDocExportForm,
} from "../../services/doc-export.js";
// spec-448 t-5: per-user "last-seen version" marker, stamped by mutating doc
// handlers only (ac-8, ac-37) — get_doc (a read) never calls into this.
import {
  upsertDocView,
} from "../../services/docViews.js";
import {
  BASE_SCAFFOLD,
  HANDOFF_BUTTON_BY_PHASE,
  toButtonPrompt,
  GET_PROMPT_PROSE,
  type Phase,
} from "@memex/shared";
import {
  MEMEX_DESC,
  VERBOSE_FIELD,
  formatState,
  fullDocState,
  handoffInterpolationContext,
  isDocLikeKind,
  reqCtx,
  resolveRefArg,
  type ToolCtx,
  type ToolSpec,
} from "./tool-contract.js";

// spec-448 t-5 (ac-8, ac-37): mutating a doc counts as "seeing" it — advance the
// caller's doc_views marker to the doc's current version so a self-authored
// change is never reported back to them as a stale catch-up banner. Advisory,
// mirroring routes/documents.ts' posture: swallow failures, a marker write must
// never break the tool's real response. get_doc (a read) deliberately never
// calls this.
async function stampDocViewFromMcp(
  memexId: string,
  docId: string,
  version: number,
  ctx: ToolCtx,
): Promise<void> {
  try {
    await upsertDocView(
      { userId: ctx.userId, docId, memexId, version, channel: ctx.channel ?? "mcp" },
      reqCtx(ctx),
    );
  } catch {
    // best-effort only.
  }
}

export const docsTools: ToolSpec[] = [
  {
    name: "get_information",
    annotations: { title: "Fetch operating guidance", readOnlyHint: true, destructiveHint: false },
    description:
      "Fetch on-demand operating guidance for working with Memex. The session-init prompt is intentionally minimal; most depth lives here. " +
      "Call with no arguments to get the topic index — each entry shows when to read that topic. " +
      "Call with `topic='<slug>'` to fetch the full body of one topic. " +
      "You MUST call this with `topic='ac-emission'` before writing any test during build — the test-tagging mechanism is silent and undetectable from the agent's side if skipped; the cost of getting it wrong is every implementation AC staying silently unverified. " +
      "Consult it for any topic referenced by other tools' descriptions or responses.",
    schema: {
      topic: z.string().optional().describe(
        "Slug of a topic to fetch (e.g. 'ac-emission', 'phases', 'decisions-vs-tasks'). Omit to get the topic index.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input) {
      const topic = input.topic as string | undefined;
      if (!topic) {
        const index = await listTopics();
        if (index.length === 0) {
          return "No guidance topics published yet.";
        }
        const lines = [
          "Available guidance topics. Call get_information(topic='<slug>') to fetch one.",
          "",
        ];
        for (const t of index) {
          lines.push(`- **${t.topic}** — ${t.title}`);
          if (t.whenToRead) lines.push(`  _When to read:_ ${t.whenToRead}`);
        }
        return lines.join("\n");
      }
      const t = await fetchTopic(topic);
      return `# ${t.title}\n\n_When to read:_ ${t.whenToRead}\n\n${t.body}`;
    },
  },

  // ── Doc CRUD ──────────────────────────────────────────────
  {
    name: "list_docs",
    annotations: { title: "List documents", readOnlyHint: true, destructiveHint: false },
    // spec-521 dec-3 (ac-6, ac-8, ac-13): the default is EVERY phase, with archived
    // the only exclusion, and the response states what it withheld. The old default
    // was a hardcoded specify/build/verify whitelist that silently dropped every
    // draft and done Spec — so "what Specs tagged `testbash` mention login?" returned
    // nothing and nothing said the set had been narrowed. The wrong answer looked
    // exactly like a right one, which is the defect this fixes; the narrow filter was
    // never the problem, its INVISIBILITY was.
    description:
      "List Specs in a Memex with decision/task counts and lineage. " +
      "By DEFAULT this returns Specs in EVERY phase — draft, specify, build, verify and done — and excludes only ARCHIVED ones. Superseded Specs are included, each row carrying its successor. " +
      "The response header states how many Specs exist, how many are shown, and how many were withheld as archived, so an answer drawn from a filtered set is never mistaken for an answer drawn from all of them. " +
      "Pass `statusIn` to NARROW to particular phases (e.g. the active working set). Pass `docType` to filter by document type (defaults to 'spec'). Pass `tags` to narrow to Specs carrying the given tags — facet semantics: AND across different scopes, OR within one scope.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      docType: z
        .string()
        .optional()
        .describe(
          "Document type filter. Defaults to 'spec'. Other values (e.g. 'standard', 'document', 'execution_plan') filter directly.",
        ),
      statusIn: z
        .array(z.string())
        .optional()
        .describe(
          "Narrow to these phases. OMIT for the default, which is every phase except archived (draft, specify, build, verify, done). " +
            'Pass e.g. ["specify","build","verify"] for just the active working set. Archived Specs are never returned regardless of what you pass here.',
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Tag filter — array of `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) strings. " +
            "AND across distinct scopes, OR within a single scope; each flat tag is its own AND clause.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const docTypeArg = (input.docType as string | undefined) ?? "spec";
      const tagFilter = input.tags as string[] | undefined;
      const memexId = await ctx.resolveMemex(memex);

      // Parse each `scope::value` string into the structured ParsedTag the
      // listDocs facet filter expects (parseTagInput validates + splits on the
      // first `::`). Empty/whitespace entries throw — surfaced as a
      // ValidationError at the boundary rather than silently dropped.
      const parsedTags: ParsedTag[] | undefined =
        tagFilter && tagFilter.length > 0 ? tagFilter.map(parseTagInput) : undefined;

      // spec-521 dec-3: fetch the WHOLE set for this docType+tags ONCE, archived
      // included, then partition in memory. One query rather than a second
      // count-the-archived round trip (std-39 cl-5), and it is what lets the header
      // report honest totals — you cannot say what you withheld if you never fetched
      // it. `documents` has no index on `status`, so phase filtering was always a
      // scan of this Memex's rows; doing it in memory costs nothing extra.
      const statusNarrow = input.statusIn as string[] | undefined;
      const everything = await listDocs(memexId, {
        docType: docTypeArg,
        includeArchived: true,
        // spec-178 t-11 / dec-11 (ac-37): the MCP/agent enumeration must NOT
        // surface handhold demo specs. The REST board route omits this flag so
        // its cards still show demo specs (with the DEMO badge); only this
        // agent-facing list path opts into the exclusion.
        excludeDemo: true,
        ...(parsedTags ? { tags: parsedTags } : {}),
      });

      const archivedCount = everything.filter((d) => d.archivedAt).length;
      const live = everything.filter((d) => !d.archivedAt);
      const docs =
        statusNarrow && statusNarrow.length > 0
          ? live.filter((d) => statusNarrow.includes(d.status))
          : live;
      const narrowedOut = live.length - docs.length;

      // spec-300 t-7 (dec-7, ac-29): on the primary Memex orient (the default
      // spec listing), append the active Skill catalogue to this early tool
      // response — the way list_memexes appends the topic index — so the agent
      // learns skills exist without being told to look. Gated on docType 'spec'
      // (the orient call, not a filtered listing) AND on skills existing (the
      // appendix is "" otherwise). This is a shared tool spec, so the SAME
      // catalogue reaches the in-app agent and a connected coding agent (ac-29).
      const catalogue =
        docTypeArg === "spec"
          ? await formatSkillCatalogueAppendix(memexId)
          : "";

      // spec-521 ac-8 — THE HONEST HEADER. Load-bearing, not decoration: it is the
      // actual fix for the original defect. The response states what it contains AND
      // what it is excluding, so an answer drawn from a filtered set can never again
      // look like an answer drawn from all of it. The rule generalises — any limit
      // added here later that hides a row MUST be visible in this line.
      const header = (shown: number): string => {
        const parts = [`${shown} of ${everything.length}`];
        if (archivedCount > 0) parts.push(`${archivedCount} archived, hidden`);
        if (narrowedOut > 0) {
          parts.push(`${narrowedOut} outside statusIn ${JSON.stringify(statusNarrow)}`);
        }
        if (archivedCount === 0 && narrowedOut === 0) {
          parts.push("nothing withheld");
        } else if (!statusNarrow) {
          parts.push('narrow with statusIn: ["specify","build","verify"]');
        }
        return `${docTypeArg === "spec" ? "Specs" : `${docTypeArg} docs`} in this Memex — ${parts.join("; ")}\n`;
      };

      if (ctx.verbose) {
        const url = await ctx.workspaceUrl(memexId);
        return header(docs.length) + formatSpecList(docs, url) + catalogue;
      }

      if (docs.length === 0) {
        // Even the empty case states the totals — "no results" and "no results in
        // the slice you asked for" are different answers, and the caller needs to
        // know which one it got.
        return `${header(0)}(none)${catalogue}`;
      }
      const slugs = await memexSlugsById(memexId);
      // std-39 cl-5: two bulk GROUP BY queries for the whole page, not two per row.
      // The former per-doc listDecisions/listTasks fan-out was tolerable at ~115 rows
      // and is not at several hundred, which is exactly what widening the default set
      // produces — so the N+1 is retired here rather than multiplied.
      const docIds = docs.map((d) => d.id);
      const [decisionCounts, taskCounts, successorHandles] = await Promise.all([
        decisionCountsByDoc(memexId, docIds),
        taskCountsByDoc(memexId, docIds),
        successorHandlesByDoc(memexId, docs),
      ]);
      // spec-538 dec-5 (ac-20, ac-21) — this list grows with the number of
      // documents in the Memex, which only ever increases and which nothing
      // prunes. Measured on the default path: 467 docs x 187 chars = 88,494,
      // refused by the client and spilled to a file — on the highest-traffic
      // read of the surface. An agent calling this to orient was getting a file
      // path instead of a list.
      const head = header(docs.length);
      const entries = docs
          .map((d) => {
            const ref = slugs ? buildDocRef(slugs, d) : d.handle;
            // ac-13: a superseded Spec STAYS in the set and carries its successor, so
            // the list itself says which Specs have been replaced. Dropping them would
            // be a second silent exclusion — the accretion dec-3 rules out.
            const successor = successorHandles.get(d.id);
            const supersededSeg = successor ? ` · superseded by ${successor}` : "";
            const decisionCount = decisionCounts.get(d.id) ?? 0;
            const taskCount = taskCounts.get(d.id) ?? 0;
            return `- ref: ${ref} [${d.docType}, ${d.status}${supersededSeg}] "${d.title}" (${decisionCount} decisions, ${taskCount} tasks)`;
          });

      // The marker is reserved BEFORE the split, so announcing the omission
      // cannot itself push the response over the line it announces.
      const OMISSION_MARKER_RESERVE = 240;
      const { kept, omitted } = boundRenderedList(entries, {
        reservedChars: head.length + catalogue.length + OMISSION_MARKER_RESERVE,
      });

      // A Memex small enough to list comfortably lists exactly as it did before
      // — same header, same lines, no marker (ac-26).
      if (omitted === 0) {
        return head + kept.join("\n") + catalogue;
      }

      // Never a silent truncation: say how many are missing and name the
      // arguments that actually narrow this call — docType, statusIn and tags
      // are real parameters on this tool, not advice invented for the message.
      const note =
        `\n… ${omitted} more not shown — this Memex holds more documents than one response can carry. ` +
        `Narrow with docType, statusIn or tags, or use search_memex.`;
      return head + kept.join("\n") + note + catalogue;
    },
  },
  {
    name: "get_doc",
    annotations: { title: "Get document", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a document, or one part of one. Given a document ref it returns the full picture: sections, decisions, tasks, comments, blockers, statuses and phase-aware guidance. " +
      "Given a DECISION, SECTION or TASK ref it returns just that part, in full and never shortened — which is how you read something a large document's response only had room to summarise. " +
      "The response includes the public URL — no separate get_doc_url call needed.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the document, e.g. `mindset/main/specs/spec-3` or `mindset/main/docs/doc-16`.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      // spec-538 dec-6 (ac-23) — a sub-ref returns THE CHILD, not an error and
      // not the parent document.
      //
      // This is what makes dec-1's truncation marker a door. It also clears the
      // 70 `expects a doc-level ref; got decision/section/task` errors (~12
      // users / 30 days) that spec-472 dec-5 identified — ahead of the redesign
      // that owns them. spec-472 dec-5 currently says a sub-ref resolves to the
      // PARENT; combined with this Spec that is a loop (the parent read is the
      // one that was truncated), so dec-6 asked for the clause to say CHILD and
      // carried the request to spec-511 dec-1 c-7.
      //
      // A child of an archived Spec still 404s: the resolver refuses it upstream
      // (spec-521 dec-2), so widening here cannot weaken that.
      if (
        resolved.entity.kind === "decision" ||
        resolved.entity.kind === "section" ||
        resolved.entity.kind === "task"
      ) {
        const childUrl = await ctx.workspaceUrl(resolved.memexId);
        // A task's blocked/READY label is derived from its blockers, which the
        // resolver does not load. Rendering the bare row would print READY for a
        // task that is actually BLOCKED — a confident lie is worse than a missing
        // field, so the blockers are fetched rather than defaulted away.
        const entity =
          resolved.entity.kind === "task"
            ? ({
                kind: "task" as const,
                row: await getTask(
                  resolved.memexId,
                  resolved.entity.row.id,
                  resolved.doc.id,
                ),
              })
            : resolved.entity;
        return formatResolvedChild(entity, resolved.doc, resolved.slugs, childUrl);
      }
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `get_doc expects a document, or a decision / section / task within one; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      if (ctx.verbose) {
        const url = await ctx.workspaceUrl(memexId);
        if (doc.docType === "standard") {
          const standard = await getStandard(memexId, doc.id);
          return formatStandard(standard, url);
        }
        const state = await fullDocState(memexId, doc.id);
        // spec-219 ac-10 / dec-4: the AC-coverage header is NO LONGER injected
        // here. The single seat (`composeGuidanceEnvelope`) composes it — verbose
        // AND get_doc only — and the choke point (`runToolWithSpecTraffic`)
        // prepends it above the body. Centralizing both header and footer in the
        // one seat is the whole point (ac-6); this handler renders only the body.
        return await formatState(url, state, ctx);
      }

      // Terse: agent already has the doc context injected by the system
      // prompt; this is for the rare case it explicitly asks. Carries the
      // canonical ref so a follow-up tool call can use it directly.
      const docRef = buildDocRef(slugs, doc);
      if (doc.docType === "standard") {
        const standard = await getStandard(memexId, doc.id);
        const header = `ref: ${docRef} "${standard.title}" (status=${standard.status}, ${standard.driftCount} open drift)`;
        const sectionLines = standard.sections
          .map((s) => {
            const sectionRef = buildChildRef(slugs, doc, { type: "sections", seq: s.seq });
            const body = renderStandardSectionBody(
              s.content,
              standard.clauses.filter((c) => c.sectionId === s.id),
            );
            return `## ${s.title ?? s.sectionType} [${s.sectionType}] (ref: ${sectionRef})\n${body}`;
          })
          .join("\n\n");
        return `${header}\n\n${sectionLines}`;
      }
      // spec-136 t-4: surface the Spec's tags inline even in the terse shape so
      // get_doc always returns them (the verbose path renders them via formatState).
      const docTags = await listDocTags(memexId, doc.id);
      const tagSuffix =
        docTags.length > 0 ? ` Tags: ${docTags.map(formatTag).join(", ")}.` : "";
      return `ref: ${docRef} "${doc.title}" [${doc.docType}, ${doc.status}].${tagSuffix}`;
    },
  },
  {
    // spec-263 — the phase handoff prompt, fetched from inside the coding
    // session. Same scaffold node, same composition path, same Org appends as
    // the web UI's copy-prompt button: the two surfaces cannot drift (std-23).
    name: "get_prompt",
    annotations: { title: "Get handoff prompt", readOnlyHint: true, destructiveHint: false },
    description:
      "Get the handoff prompt for a Spec's CURRENT phase — the exact text the web UI's copy-prompt button produces (specify → plan handoff, build → build handoff, verify → verify handoff), composed from the shared Scaffold with your Org's additions included. " +
      "Call it after orienting on a Spec or right after a phase transition, when you need the full handoff prompt to act on. " +
      "Phases with no handoff (draft, done) return an explanation, never an error. Spec-only.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec, e.g. `mindset/main/specs/spec-3`."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `get_prompt expects a doc-level Spec ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc } = resolved;
      if (doc.docType !== "spec") {
        throw new ValidationError(
          `get_prompt expects a Spec; ${doc.handle} is a ${doc.docType}. Handoff prompts exist only on Specs.`,
        );
      }
      // dec-1: select for the CURRENT phase through the SAME map the UI copy
      // button and the footer essence select through (spec-203 dec-1) — node
      // selection is single-source by construction. draft/done carry no node;
      // explain, never throw or return empty (ac-7 / scope ac-4).
      const phase = doc.status as Phase;
      const buttonId = HANDOFF_BUTTON_BY_PHASE[phase];
      if (!buttonId) return GET_PROMPT_PROSE.noHandoff(phase);
      const baseUrl = await ctx.workspaceUrl(memexId);
      const context = handoffInterpolationContext(baseUrl, doc);
      if (!context) return GET_PROMPT_PROSE.noContext;
      // dec-2: Org appends ride the composition, so the returned text is
      // byte-identical to the UI button's clipboard output (PromptButton.tsx
      // threads orgBlocks the same way).
      const orgBlocks = ctx.getOrgBlocksForNudge
        ? await ctx.getOrgBlocksForNudge()
        : undefined;
      const prompt = toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId,
        context,
        orgBlocks,
      });
      if (prompt === null) {
        // Unreachable while every HANDOFF_BUTTON_BY_PHASE id has a node in
        // BASE_SCAFFOLD (pinned by shared tests) — a missing node is scaffold
        // corruption, not a caller error.
        throw new Error(`No PromptButtonNode found for buttonId="${buttonId}".`);
      }
      return prompt;
    },
  },
  {
    name: "export_doc",
    annotations: { title: "Export document (lossless markdown)", readOnlyHint: true, destructiveHint: false },
    description:
      "spec-100 §4: export a spec as lossless markdown with every comment thread expanded inline at its anchor position (HTML-comment-delimited block-quotes). Floating comments are appended per section. This is the form to paste into an external LLM/editor, or hand to a colleague, without losing the conversation. `ref` is a doc-level canonical ref.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the document to export, e.g. `mindset/main/specs/spec-3`."),
      // Carried for parity with the shared verbose contract (doc-20 t-10): every
      // tool exposes VERBOSE_FIELD by identity. export_doc is always lossless, so
      // the flag is a no-op here, but the field must be present for the audit.
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `export_doc expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      return buildDocExportForm(resolved.memexId, resolved.doc.id);
    },
  },
  {
    name: "create_doc",
    annotations: { title: "Create document", readOnlyHint: false, destructiveHint: false },
    description:
      "Create a new Spec. Pass `purpose` for the Overview narrative. Optional `decisions` seeds open decisions on creation. Optional `promoteFromTaskRef` (a canonical task ref) creates a child Spec whose parent is the task's source Spec, preserving lineage. Optional `promoteFromIssueRef` (a canonical issue ref) does the same from an Issue — the child Spec is parented to the Issue's source Spec, the Issue → converted, and it auto-resolves when the child Spec reaches done. Optional `docType` defaults to 'spec'; pass any other docType the service layer recognises ('standard', 'document', 'execution_plan'). **Run `search_memex({ query })` first** to discover whether an existing Spec, Standard, or prior Decision already covers this — surface any overlap in the confirmation before creating. " +
      "**After creating a spec in draft/specify, your next move is to create its scope acceptance criteria** via `create_ac({ ref: '<this-spec>', kind: 'scope', statement: '...' })`: plain-English statements of what 'done' looks like, which anchor every downstream decision. Create as many as genuinely capture success, usually three to six; without them the spec has no measurable success criteria.",
    schema: {
      memex: z
        .string()
        .optional()
        .describe(
          MEMEX_DESC +
            " (not needed if promoteFromTaskRef or promoteFromIssueRef is provided — the Memex is inferred from the source)",
        ),
      title: z.string().describe("Spec title (1–500 chars)."),
      purpose: z
        .string()
        .optional()
        .describe("Overview narrative. Required unless `promoteFromTaskRef` / `promoteFromIssueRef` is used."),
      docType: z
        .string()
        .optional()
        .describe(
          "Document type. Defaults to 'spec'. Pass 'standard', 'document', or 'execution_plan' to override.",
        ),
      decisions: z
        .array(
          z.object({
            title: z.string(),
            context: z.string().optional(),
          }),
        )
        .optional()
        .describe("Seed open decisions at creation."),
      promoteFromTaskRef: z
        .string()
        .optional()
        .describe(
          "Promote a task to a child Spec. Canonical task ref (e.g. `mindset/main/specs/spec-3/tasks/t-2`). Lineage preserved.",
        ),
      promoteFromIssueRef: z
        .string()
        .optional()
        .describe(
          "Promote an Issue to a child Spec. Canonical issue ref (e.g. `mindset/main/specs/spec-3/issues/issue-2`). The child Spec is parented to the Issue's SOURCE Spec (lineage preserved); the Issue → converted and auto-resolves when the child Spec reaches done.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const args = input as {
        memex?: string;
        title: string;
        purpose?: string;
        docType?: string;
        decisions?: Array<{ title: string; context?: string }>;
        promoteFromTaskRef?: string;
        promoteFromIssueRef?: string;
      };

      if (args.promoteFromIssueRef) {
        const resolved = await resolveRefArg(ctx, args.promoteFromIssueRef, "promoteFromIssueRef");
        if (resolved.entity.kind !== "issue") {
          throw new ValidationError(
            `promoteFromIssueRef must resolve to an issue; got ${resolved.entity.kind}.`,
          );
        }
        // The Issue's SOURCE Spec is its parent doc (issues.doc_id → documents.id).
        // promoteToSpec parents the child Spec on it, preserving lineage (ac-23).
        const sourceDoc = resolved.doc;
        const child = await promoteToSpec(
          resolved.memexId,
          sourceDoc.id,
          args.title,
          args.purpose,
          ctx.userId,
          reqCtx(ctx),
        );
        // Issue → converted, record promoted_doc_id so the child-done hook resolves
        // it later (ac-24). NOT resolved now — only when the child Spec reaches done.
        await markIssuePromoted(resolved.memexId, resolved.entity.row.id, child.id);
        await stampDocViewFromMcp(resolved.memexId, child.id, child.version, ctx);
        const childRef = buildDocRef(resolved.slugs, child);
        if (ctx.verbose) {
          return `Promoted Issue issue-${resolved.entity.row.seq} to child Spec ref: ${childRef} "${child.title}" (parent: ${sourceDoc.handle}). Issue → converted; auto-resolves when the child Spec reaches done.`;
        }
        return `Promoted issue issue-${resolved.entity.row.seq} to Spec ref: ${childRef} "${child.title}".`;
      }

      if (args.promoteFromTaskRef) {
        const resolved = await resolveRefArg(ctx, args.promoteFromTaskRef, "promoteFromTaskRef");
        if (resolved.entity.kind !== "task") {
          throw new ValidationError(
            `promoteFromTaskRef must resolve to a task; got ${resolved.entity.kind}.`,
          );
        }
        const item = await getTask(resolved.memexId, resolved.entity.row.id);
        const sourceDoc = resolved.doc;
        const child = await promoteToSpec(
          resolved.memexId,
          sourceDoc.id,
          args.title,
          args.purpose,
          ctx.userId,
          reqCtx(ctx),
        );
        await stampDocViewFromMcp(resolved.memexId, child.id, child.version, ctx);
        if (ctx.verbose) {
          const url = await ctx.workspaceUrl(resolved.memexId);
          return formatPromotedSpec(child, sourceDoc, item, url);
        }
        const childRef = buildDocRef(resolved.slugs, child);
        return `Promoted task t-${item.seq} to Spec ref: ${childRef} "${child.title}".`;
      }

      const memexId = await ctx.resolveMemex(args.memex);
      if (!args.purpose) {
        throw new ValidationError("create_doc requires `purpose` (Overview narrative).");
      }
      // Default to canonical 'spec' for callers that don't pass an explicit
      // docType.
      const docType = args.docType ?? "spec";
      // spec-295 dec-3: the web agent (in_app_agent channel — the creation
      // modal + the in-app spec agent) no longer auto-advances phase, so a new
      // Spec can't rely on draft→specify traffic to become team-visible. Place
      // it in `specify` deterministically at creation instead. Only Specs get a
      // phase (standards/documents have their own status lifecycle); the mcp
      // surface keeps 'draft' (it still auto-advances).
      const initialStatus =
        docType === "spec" && ctx.channel === "in_app_agent" ? "specify" : undefined;
      const doc = await createDocDraft(
        memexId,
        args.title,
        args.purpose,
        docType,
        args.decisions,
        initialStatus ? { initialStatus } : undefined,
        ctx.userId,
        reqCtx(ctx),
      );
      await stampDocViewFromMcp(memexId, doc.id, doc.version, ctx);
      if (ctx.verbose) {
        const state = await fullDocState(memexId, doc.id);
        const url = await ctx.workspaceUrl(memexId);
        return await formatState(url, state, ctx);
      }
      const slugs = await memexSlugsById(memexId);
      const docRef = slugs ? buildDocRef(slugs, doc) : doc.handle;
      // spec-219 Phase 2 (sole-author): create_doc resolves no ref, so the choke
      // never set a target. Record the just-created doc so composeGuidanceEnvelope
      // runs for it (like every other Spec-resolving tool), and signal the event
      // — the activation-moment scope-AC / standard-clauses guidance is authored
      // by composeGuidanceEnvelope, not here.
      ctx.recordCreatedDoc?.(memexId, doc.id);
      if (ctx.footerSlot) {
        ctx.footerSlot.signal = { kind: "doc_created", docRef, docType };
      }
      return `Spec created: ref: ${docRef} "${doc.title}".`;
    },
  },
  {
    name: "update_doc",
    annotations: { title: "Update document", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a document's status, title, and/or tags. Pass only the fields you want to change. " +
      "**status** transitions a Spec through draft → specify → build → verify → done; backward moves and pauses are supported. Run `assess_spec({mode:'phase', target:<phase>})` BEFORE any forward Spec transition past specify — it returns the rubric + a fact sheet of open decisions / incomplete work / drift. Closing to 'done' is the user's call. " +
      "**title** renames the document (handle stays immutable). " +
      "**tags** adds tags to the Spec — array of `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) strings; a scoped tag is mutually exclusive within its scope (applying `priority::high` drops any other `priority::*`). New tags are created on first use. " +
      "**removeTags** removes the given tags from the Spec (same string form); removing a tag the Spec doesn't carry is a no-op. " +
      "Replaces update_doc_status, update_doc_title.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the document, e.g. `mindset/main/specs/spec-3` or `mindset/main/docs/doc-16`.",
        ),
      status: z.enum(DOC_STATUSES).optional().describe("New lifecycle status (spec/document)."),
      title: z.string().optional().describe("New title (1-500 chars, trimmed)."),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Tags to ADD to the Spec — `scope::value` (e.g. `priority::high`) or flat (e.g. `bug`) strings. " +
            "Scoped tags are mutually exclusive within their scope; new tags are created on first use.",
        ),
      removeTags: z
        .array(z.string())
        .optional()
        .describe(
          "Tags to REMOVE from the Spec — same `scope::value`/flat string form. Removing an absent tag is a no-op.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const status = input.status as string | undefined;
      const title = input.title as string | undefined;
      const tagsToAdd = input.tags as string[] | undefined;
      const tagsToRemove = input.removeTags as string[] | undefined;

      const hasTagWork =
        (tagsToAdd && tagsToAdd.length > 0) || (tagsToRemove && tagsToRemove.length > 0);
      if (status === undefined && title === undefined && !hasTagWork) {
        throw new ValidationError(
          "update_doc requires at least one of: status, title, tags, removeTags.",
        );
      }
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `update_doc expects a doc-level ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc: before, slugs } = resolved;

      if (status !== undefined) {
        // spec-122 dec-2/dec-5: thread the activity contract (WHO + HOW) onto the
        // status transition so Pulse attributes the phase move to the human +
        // surface.
        await updateDocStatus(memexId, before.id, status, { ctx: reqCtx(ctx) });
        // spec-219 Phase 2 (sole-author): the transition guidance (assess_spec
        // tip + coverage nudge) is owned by composeGuidanceEnvelope; signal the
        // transition, don't author it here.
        if (ctx.footerSlot) {
          ctx.footerSlot.signal = {
            kind: "doc_transition",
            beforeStatus: before.status,
            target: status,
            docType: before.docType,
          };
        }
      }
      if (title !== undefined) {
        await updateDocTitle(memexId, before.id, title);
      }
      // Tag writes route through the tags service (never raw inserts): applyTagString
      // handles create-or-pick + per-scope mutual exclusivity; removeTagString resolves
      // the existing tag and drops the link (no-op if absent). Attribution: the link's
      // added_by is ctx.userId (mirrors the assign handler), and the channel records
      // the actor *kind* on the bus event → activity_log (spec-122).
      // spec-156 ac-19: derive the channel from the invoking surface instead of
      // hardcoding `mcp` — the in-app agent path sets `in_app_agent`, so Pulse
      // attributes agent-driven tagging correctly. Defaults to `mcp` for the MCP
      // surface (and any ctx that doesn't set it).
      const tagCtx = { channel: ctx.channel ?? "mcp", userId: ctx.userId };
      const appliedTags: string[] = [];
      const removedTags: string[] = [];
      if (tagsToAdd) {
        for (const raw of tagsToAdd) {
          const tag = await applyTagString(tagCtx, memexId, before.id, raw, ctx.userId);
          appliedTags.push(formatTag(tag));
        }
      }
      if (tagsToRemove) {
        for (const raw of tagsToRemove) {
          const tag = await removeTagString(tagCtx, memexId, before.id, raw);
          if (tag) removedTags.push(formatTag(tag));
        }
      }

      // spec-448 t-5 (ac-8, ac-37): this handler mutated the doc (status/title/
      // tags), so stamp the caller's doc_views marker. `before.version` is the
      // doc's current version — none of status/title/tag writes touch
      // `documents.version` (only cutVersion does), so no re-fetch is needed.
      await stampDocViewFromMcp(memexId, before.id, before.version, ctx);

      // One-line summary of any tag mutation, shared by both response shapes so
      // the agent learns what landed without a follow-up get_doc.
      const tagParts: string[] = [];
      if (appliedTags.length > 0) tagParts.push(`tagged ${appliedTags.join(", ")}`);
      if (removedTags.length > 0) tagParts.push(`removed ${removedTags.join(", ")}`);
      const tagSuffix = tagParts.length > 0 ? ` (${tagParts.join("; ")})` : "";

      if (ctx.verbose) {
        const state = await fullDocState(memexId, before.id);
        const url = await ctx.workspaceUrl(memexId);
        // spec-219 Phase 2 (sole-author): the transition guidance is signalled
        // above; composeGuidanceEnvelope authors it. `tagSuffix` is a FACT
        // (result-reporting), so it rides the body, not the footer.
        const body = await formatState(url, state, ctx);
        return tagSuffix ? `${body}\n${tagSuffix.trim()}` : body;
      }
      const fresh = await getDoc(memexId, before.id);
      // Per dec-1: on a status change include the deterministic phase header so
      // the agent learns the new "Allowed now" without another assess_spec.
      const phaseLine =
        status !== undefined && fresh.docType === "spec"
          ? formatTerseSpecPhase(fresh.status)
          : null;
      const phaseSuffix = phaseLine ? ` ${phaseLine}` : "";
      const freshRef = buildDocRef(slugs, fresh);
      return `ref: ${freshRef} updated.${tagSuffix}${phaseSuffix}`;
    },
  },

  // ── Section CRUD ──────────────────────────────────────────
];
