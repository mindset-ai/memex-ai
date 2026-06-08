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

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { getAnthropicClient } from "../agent/anthropic-client.js";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces } from "../db/schema.js";
import { getDoc } from "./documents.js";
import { listDecisions } from "./decisions.js";
import { listAcsForBrief } from "./acs.js";
import { publishEntry, getEntryBySpecRef, type NewWhatsNewEntry } from "./whats-new.js";
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

// Structured-output contract: a user-facing release-note entry.
export const WhatsNewDraftSchema = z.object({
  // A short, benefit-led headline (NOT the raw Spec title).
  title: z.string(),
  // WHAT shipped, plain language.
  what: z.string(),
  // WHY it matters to the user, plain language.
  why: z.string(),
});
export type WhatsNewDraft = z.infer<typeof WhatsNewDraftSchema>;

// Minimal Anthropic surface used here, so tests inject a stub.
export interface AnthropicLike {
  messages: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (args: any) => Promise<{ parsed_output: WhatsNewDraft | null }>;
  };
}

export interface GenerateOptions {
  /** Injected client for tests; defaults to the shared Anthropic client. */
  client?: AnthropicLike;
}

// The generation prompt. Kept here (not packages/server/src/agent/phases/) to
// mirror the clause-translator transform-prompt precedent; could move to
// @memex/shared if a reviewer prefers parity with CLAUSE_TRANSLATOR_PROMPT.
export const WHATS_NEW_SYSTEM_PROMPT = `You write release notes for Memex users.

You are given a digest of a software Spec that just shipped to production: its purpose, the decisions made, and the acceptance criteria that define success. Turn it into ONE release-note entry with three fields:

- "title": a short, friendly, benefit-led headline (max ~8 words). Describe the user-visible win, not the internal feature name. No "spec-N", no jargon.
- "what": one or two plain sentences saying WHAT changed, from the user's point of view.
- "why": one or two plain sentences saying WHY it matters to the user — the benefit they get.

Rules:
- Write for an end user, never an engineer. No internal vocabulary (no "decision", "AC", "migration", "endpoint", phase names, file paths).
- Lead with the benefit. This is a "here's what's new and why you'll like it" note, not a changelog line.
- Be concrete and warm, never marketing-fluffy. No exclamation-mark spam.
- If the Spec is purely internal with no user-facing effect, still describe the closest user benefit honestly (e.g. reliability, speed) rather than inventing a feature.`;

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
 * Draft a What's New entry for a Spec (no DB write). Throws SpecNotShippableError
 * for a draft/specify Spec (ac-7), and Error for a non-spec or empty model output.
 */
export async function draftEntryForSpec(
  memexId: string,
  specHandleOrId: string,
  opts: GenerateOptions = {},
): Promise<NewWhatsNewEntry> {
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
  if (!draft || !draft.what.trim() || !draft.why.trim() || !draft.title.trim()) {
    throw new Error(`Empty What's New draft for ${doc.handle}.`);
  }

  return {
    sourceSpecRef,
    sourceSpecHandle: doc.handle,
    title: draft.title.trim(),
    whatText: draft.what.trim(),
    whyText: draft.why.trim(),
  };
}

/**
 * Generate + publish an entry for a Spec, idempotently (ac-6). Returns the
 * published row, or null if the Spec isn't a shippable spec (ac-7) or already
 * had an entry — so a deploy-time batch loop is resilient and never throws
 * per-Spec.
 *
 * The cheap guards (not-a-spec / not-shippable / already-published) run BEFORE
 * the LLM call, so a re-run over already-published Specs costs zero model calls
 * — important for bounding the daily deploy batch.
 */
export async function generateAndPublishForSpec(
  memexId: string,
  specHandleOrId: string,
  opts: GenerateOptions = {},
): Promise<WhatsNewEntry | null> {
  const doc = await getDoc(memexId, specHandleOrId);
  if (doc.docType !== "spec") return null;
  if (NON_SHIPPABLE_PHASES.has(doc.status)) return null; // ac-7

  const slugs = await resolveSpecSlugs(doc.id);
  if (!slugs) return null;
  const sourceSpecRef = `${slugs.namespace}/${slugs.memex}/specs/${slugs.handle}`;

  // Idempotent: already published → no rewrite, and crucially no LLM call.
  if (await getEntryBySpecRef(sourceSpecRef)) return null;

  const draft = await draftEntryForSpec(memexId, specHandleOrId, opts);
  return publishEntry(draft);
}

/** Outcome of a batch generation run (returned to the deploy script for logging). */
export interface WhatsNewGenerationResult {
  /** Specs newly published this run. */
  generated: number;
  /** Specs skipped (already published, or filtered out before the loop). */
  skipped: number;
  /** Total shippable, non-archived specs considered. */
  total: number;
  /** True if MAX_PER_RUN was hit and shippable specs remain for the next run. */
  capped: boolean;
}

// Bound the LLM fan-out per deploy (spec-178 t-5 lesson: a deploy step that
// fans out unboundedly hung the deploy). Only UNPUBLISHED shippable specs draft,
// so steady state is "today's promotions"; the cap protects the first backfill
// run, which resumes idempotently on the next deploy.
const MAX_PER_RUN_DEFAULT = 25;

export interface BatchOptions extends GenerateOptions {
  /** Max entries to GENERATE this run. Default 25. */
  max?: number;
}

/**
 * Generate + publish entries for all shippable, not-yet-published Specs in a
 * Memex (dec-2: run at the daily prod promotion). Idempotent, bounded by `max`,
 * and never throws per-Spec — safe for a non-gating deploy step.
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
  for (const { handle } of candidates) {
    if (generated >= max) {
      return { generated, skipped, total: candidates.length, capped: true };
    }
    const published = await generateAndPublishForSpec(memexId, handle, opts);
    if (published) generated++;
    else skipped++;
  }
  return { generated, skipped, total: candidates.length, capped: false };
}
