// spec-200 t-2: auto-generate a What's New entry from a Spec.
//
// dec-1 (fully auto, no approval): given a Spec, draft a user-facing What/Why
// from its Overview + resolved Decisions + Scope ACs and publish it STRAIGHT to
// the feed (no pending-approval state). The generation prompt is the ONLY quality
// control now, so it is tuned to emit benefit-led prose, not a dry changelog.
//
// Uses Anthropic structured outputs via getAnthropicClient() — the same precedent
// as services/clause-translator.ts (messages.parse + zodOutputFormat). The client
// is injectable so tests run key-free with a stub.
//
// ac-6: draft-from-spec → write straight to feed, no approval path.
// ac-7: only ingest shippable Specs — a draft/specify (private/authoring) Spec
//       produces no entry. The deploy hook (t-3) supplies the stronger "actually
//       promoted to prod" gate; this is the service-level backstop.
// ac-16 (dec-7): the model also judges WORTHINESS — only noteworthy, user-facing
//       Specs publish; bug-fixes / internal / chores are recorded as skips so the
//       feed stays a curated highlights list, not a changelog. Each Spec is judged
//       exactly once (the skip verdict is persisted in whats_new_skips).

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { WHATS_NEW_SYSTEM_PROMPT } from "@memex/shared";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces } from "../db/schema.js";
import { getDoc } from "./documents.js";
import { listDecisions } from "./decisions.js";
import { listAcsForBrief } from "./acs.js";
import { publishEntry, recordSkip, isAlreadyEvaluated, type NewWhatsNewEntry } from "./whats-new.js";
import type { WhatsNewEntry } from "../db/schema.js";

// Same model as clause-translator + the chat route (std-11 / routes/llm.ts).
const MODEL = "claude-sonnet-4-5-20250929";

// Phases that mean the Spec has NOT shipped — private authoring / pre-execution.
// A Spec in build/verify/done has reached the line where a release note is sane;
// the deploy hook narrows further to "promoted to prod today".
const NON_SHIPPABLE_PHASES = new Set(["draft", "specify"]);

/** Thrown when a Spec is not in a shippable phase (ac-7 guard). */
export class SpecNotShippableError extends Error {
  constructor(handle: string, phase: string) {
    super(`Spec ${handle} is in '${phase}' — not shippable; no What's New entry generated.`);
    this.name = "SpecNotShippableError";
  }
}

// Structured-output contract: the worthiness verdict (dec-7) + the draft (only
// when worthy). title/what/why are optional because the model omits them when it
// judges the Spec not worth announcing.
export const WhatsNewDraftSchema = z.object({
  // dec-7: is this a noteworthy, user-facing change worth a What's New entry?
  worthAnnouncing: z.boolean(),
  // One-line justification for the verdict (debug / audit).
  reason: z.string(),
  // A short, benefit-led headline (NOT the raw Spec title). Present iff worthy.
  title: z.string().optional(),
  // WHAT shipped, plain language. Present iff worthy.
  what: z.string().optional(),
  // WHY it matters to the user, plain language. Present iff worthy.
  why: z.string().optional(),
});
export type WhatsNewDraft = z.infer<typeof WhatsNewDraftSchema>;

/** The verdict + (when worthy) the entry to publish. */
export interface DraftVerdict {
  worthAnnouncing: boolean;
  reason: string;
  entry: NewWhatsNewEntry | null;
}

/** Outcome of evaluating one Spec (drives the batch cap + the script log). */
export type GenerationOutcome =
  | { status: "published"; entry: WhatsNewEntry }
  | { status: "skipped"; reason: string }
  | { status: "already-evaluated" }
  | { status: "not-shippable" };

// Minimal Anthropic surface used here, so tests inject a stub.
export interface AnthropicLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (args: any) => Promise<{ parsed_output: WhatsNewDraft | null }>;
  };
}

/** True when the model judged the Spec worth announcing AND gave usable copy. */
function isPublishableDraft(d: WhatsNewDraft): boolean {
  return !!d.worthAnnouncing && !!d.title?.trim() && !!d.what?.trim() && !!d.why?.trim();
}

export interface GenerateOptions {
  /** Injected client for tests; defaults to the shared Anthropic client. */
  client?: AnthropicLike;
}

interface SpecSlugs {
  namespace: string;
  memex: string;
  handle: string;
}

/** Resolve a doc's namespace/memex/handle slugs to build its canonical ref. */
async function resolveSpecSlugs(docId: string): Promise<SpecSlugs | null> {
  const [row] = await db
    .select({
      namespace: namespaces.slug,
      memex: memexes.slug,
      handle: documents.handle,
    })
    .from(documents)
    .innerJoin(memexes, eq(documents.memexId, memexes.id))
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(documents.id, docId));
  return row ?? null;
}

/** Build the digest fed to the model: title + overview + resolved decisions + scope ACs. */
function buildSpecDigest(args: {
  title: string;
  overview: string;
  resolvedDecisions: { title: string; resolution: string }[];
  scopeAcs: string[];
}): string {
  const decisions =
    args.resolvedDecisions.length > 0
      ? args.resolvedDecisions
          .map((d, i) => `${i + 1}. ${d.title}\n   → ${d.resolution}`)
          .join("\n")
      : "(none)";
  const acs = args.scopeAcs.length > 0 ? args.scopeAcs.map((s) => `- ${s}`).join("\n") : "(none)";
  return [
    `SPEC TITLE: ${args.title}`,
    ``,
    `PURPOSE (overview):`,
    args.overview || "(no overview)",
    ``,
    `KEY DECISIONS:`,
    decisions,
    ``,
    `SUCCESS CRITERIA (scope):`,
    acs,
  ].join("\n");
}

/**
 * Judge + draft for a Spec (no DB write). Returns the worthiness verdict (dec-7)
 * and, when worthy, the entry to publish. Throws SpecNotShippableError for a
 * draft/specify Spec (ac-7) and Error for a non-spec or malformed model output.
 */
export async function draftEntryForSpec(
  memexId: string,
  specHandleOrId: string,
  opts: GenerateOptions = {},
): Promise<DraftVerdict> {
  const doc = await getDoc(memexId, specHandleOrId);
  if (doc.docType !== "spec") {
    throw new Error(`Document ${specHandleOrId} is not a spec (docType=${doc.docType}).`);
  }
  // ac-7: never generate from a private/authoring Spec.
  if (NON_SHIPPABLE_PHASES.has(doc.status)) {
    throw new SpecNotShippableError(doc.handle, doc.status);
  }

  const slugs = await resolveSpecSlugs(doc.id);
  if (!slugs) throw new Error(`Could not resolve canonical ref for ${doc.handle}.`);
  const sourceSpecRef = `${slugs.namespace}/${slugs.memex}/specs/${slugs.handle}`;

  const overviewSection = doc.sections.find((s) => s.sectionType === "overview");
  const resolved = (await listDecisions(memexId, doc.id))
    .filter((d) => d.status === "resolved" && d.resolution)
    .map((d) => ({ title: d.title, resolution: d.resolution as string }));
  const scopeAcs = (await listAcsForBrief(memexId, doc.id, { kind: "scope", status: "active" })).map(
    (a) => a.statement,
  );

  const digest = buildSpecDigest({
    title: doc.title,
    overview: overviewSection?.content ?? "",
    resolvedDecisions: resolved,
    scopeAcs,
  });

  const client = opts.client ?? (getAnthropicClient() as unknown as AnthropicLike);
  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system: WHATS_NEW_SYSTEM_PROMPT,
    output_config: { format: zodOutputFormat(WhatsNewDraftSchema) },
    messages: [{ role: "user", content: digest }],
  });

  const draft = message.parsed_output;
  if (!draft) throw new Error(`Empty What's New model output for ${doc.handle}.`);

  // dec-7: not worth announcing → no entry (the caller persists the skip verdict).
  if (!isPublishableDraft(draft)) {
    return { worthAnnouncing: false, reason: draft.reason || "not noteworthy", entry: null };
  }

  return {
    worthAnnouncing: true,
    reason: draft.reason || "",
    entry: {
      sourceSpecRef,
      sourceSpecHandle: doc.handle,
      title: draft.title!.trim(),
      whatText: draft.what!.trim(),
      whyText: draft.why!.trim(),
    },
  };
}

/**
 * Evaluate a Spec and act on the verdict (dec-7), idempotently. Cheap guards
 * (not-a-spec / not-shippable / already-evaluated) run BEFORE the LLM call so a
 * re-run costs zero model calls. Worthy → publish; not worthy → record the skip
 * so the Spec is never re-judged. Never throws per-Spec — safe for the batch.
 */
export async function generateAndPublishForSpec(
  memexId: string,
  specHandleOrId: string,
  opts: GenerateOptions = {},
): Promise<GenerationOutcome> {
  const doc = await getDoc(memexId, specHandleOrId);
  if (doc.docType !== "spec") return { status: "not-shippable" };
  if (NON_SHIPPABLE_PHASES.has(doc.status)) return { status: "not-shippable" }; // ac-7

  const slugs = await resolveSpecSlugs(doc.id);
  if (!slugs) return { status: "not-shippable" };
  const sourceSpecRef = `${slugs.namespace}/${slugs.memex}/specs/${slugs.handle}`;

  // dec-7: judged exactly once — already published OR skipped → no LLM call.
  if (await isAlreadyEvaluated(sourceSpecRef)) return { status: "already-evaluated" };

  const verdict = await draftEntryForSpec(memexId, specHandleOrId, opts);
  if (!verdict.worthAnnouncing || !verdict.entry) {
    await recordSkip({ sourceSpecRef, sourceSpecHandle: doc.handle, reason: verdict.reason });
    return { status: "skipped", reason: verdict.reason };
  }

  const entry = await publishEntry(verdict.entry);
  // A concurrent run may have published first; treat that as already-evaluated.
  return entry ? { status: "published", entry } : { status: "already-evaluated" };
}

/** Outcome of a batch generation run (returned to the deploy script for logging). */
export interface WhatsNewGenerationResult {
  /** Specs newly PUBLISHED this run (judged worthy). */
  generated: number;
  /** Specs judged NOT worth announcing this run (skip verdict persisted). */
  skipped: number;
  /** Specs that consumed an LLM judgement this run (generated + skipped). */
  evaluated: number;
  /** Total shippable, non-archived specs considered. */
  total: number;
  /** True if the per-run evaluation cap was hit and un-judged specs remain. */
  capped: boolean;
}

// Bound the LLM fan-out per deploy (spec-178 t-5 lesson: a deploy step that fans
// out unboundedly hung the deploy). Caps the number of LLM JUDGEMENTS per run —
// already-evaluated specs (published OR skipped, dec-7) cost zero calls, so steady
// state is just "today's promotions"; the cap protects only the first backfill,
// which resumes idempotently on the next deploy.
const MAX_PER_RUN_DEFAULT = 25;

export interface BatchOptions extends GenerateOptions {
  /** Max LLM judgements this run. Default 25. */
  max?: number;
}

/**
 * Evaluate all shippable, not-yet-judged Specs in a Memex (dec-2: run at the daily
 * prod promotion). Judges each once (dec-7) — worthy → publish, else → record skip.
 * Idempotent, bounded by `max` LLM judgements, never throws per-Spec.
 */
export async function runWhatsNewGeneration(
  memexId: string,
  opts: BatchOptions = {},
): Promise<WhatsNewGenerationResult> {
  const max = opts.max ?? MAX_PER_RUN_DEFAULT;
  // Candidate specs: real specs, not archived, past the private/authoring phases.
  const candidates = await db
    .select({ handle: documents.handle })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        isNull(documents.archivedAt),
        notInArray(documents.status, ["draft", "specify"]),
      ),
    )
    .orderBy(documents.handle);

  let generated = 0;
  let skipped = 0;
  let evaluated = 0;
  for (const { handle } of candidates) {
    if (evaluated >= max) {
      return { generated, skipped, evaluated, total: candidates.length, capped: true };
    }
    const outcome = await generateAndPublishForSpec(memexId, handle, opts);
    // Only LLM judgements count toward the cap; already-evaluated / non-shippable
    // specs short-circuit before the model call.
    if (outcome.status === "published") {
      generated++;
      evaluated++;
    } else if (outcome.status === "skipped") {
      skipped++;
      evaluated++;
    }
  }
  return { generated, skipped, evaluated, total: candidates.length, capped: false };
}
