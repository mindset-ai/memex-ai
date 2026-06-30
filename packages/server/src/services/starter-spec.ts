// Variant B starter spec — seed (spec-426 dec-3 / dec-4 / s-6).
//
// The `starter_spec` provisioning behaviour (dec-4 registry id). Where Variant A
// (spec-178's seedHandholdDemo) seeds five frozen `is_demo` walkthrough copies,
// Variant B seeds ONE real, editable Spec — "Understanding Memex" — into a new
// personal Memex at status `specify`, so it sits in the SPECIFY column where a brand-
// new user (themselves at the specify stage of their first spec) sees a spec actively
// being shaped: narrative + genuine resolved decisions + scope acceptance criteria.
//
// dec-3 revision (specify, not done): completed tasks and synthetic 'verified' ACs are
// build/verify-phase artefacts that would be phase-incoherent in the Specify column, so
// this seed carries NEITHER. A specify-phase spec is exactly: shaped narrative, resolved
// decisions, and scope ACs (unverified — which is correct at specify). The canonical
// content lives ONCE in db/starter-spec.fixture.ts; this module maps it through the
// existing service primitives (createDocDraft / addSection / createDecision /
// resolveDecision / createAc — each already wraps mutate() + emits, std-8). Unlike the
// handhold demo it leaves documents.is_demo=FALSE (the spec is genuinely searchable,
// agent-visible, and editable).
//
// ── THE HARD CORRECTNESS INVARIANT (dec-3 / ac-2 / ac-3) ──────────────────────
// The Spec AND every child (decisions, ACs) MUST be SYSTEM-attributed — never the new
// user. Grounded against journey-state.ts:108–191 (verified): every onboarding milestone
// counts ONLY rows whose `createdByUserId` / `actorUserId` equals the user —
//   hasSpec            documents.createdByUserId = user  (L108–117)
//   hasResolvedDecision decisions.actorUserId    = user  (L120–123)
//   hasAc              acs.actorUserId            = user  (L126–129)
// Because `is_demo=false`, the spec-178 isDemo exclusion does NOT protect us here — the
// ONLY thing keeping this seed from advancing the user's journey is its system
// attribution. So this seeder writes every row through a ctx that carries NO actorUserId,
// and never threads a createdByUserId. NULL actor is the documented "system write" of
// services/actor.ts, and NULL can never equal a user id, so every milestone gate above
// stays false by construction. We deliberately STRIP any actorUserId the caller may pass
// so the invariant holds no matter how seedStarterSpec is invoked.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { mutate, type RequestCtx } from "./mutate.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { createAc } from "./acs.js";
import {
  STARTER_SPEC_TITLE,
  STARTER_SPEC_SECTIONS,
  STARTER_SPEC_SECTION_ORDER,
  STARTER_SPEC_DECISIONS,
  STARTER_SPEC_ACS,
} from "../db/starter-spec.fixture.js";

// True if this memex already carries the system-attributed starter spec. The
// idempotency marker is (docType='spec', title='Understanding Memex',
// createdByUserId IS NULL): is_demo can't be the marker here (the spec is
// is_demo=false), and the NULL-creator + canonical title pair distinguishes the
// seeded spec from a user's own spec they happen to title the same (theirs carries
// their createdByUserId). Makes signup, re-seed, and races safe.
async function starterSpecExists(memexId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.memexId, memexId),
        eq(documents.docType, "spec"),
        eq(documents.title, STARTER_SPEC_TITLE),
        isNull(documents.createdByUserId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Idempotently seed the "Understanding Memex" starter spec into `memexId` (the
 * `starter_spec` provisioning behaviour, dec-4).
 *
 * NO-OP if the memex already holds the system-attributed starter spec, so repeated
 * calls (signup race twin, deploy backfill, re-provision) are safe.
 *
 * @param ctx Carries the channel (HOW) for the std-32 activity contract. Any
 *   actorUserId/actorName on it is DELIBERATELY DROPPED — the seed is system-written
 *   so it can never advance the new user's onboarding journey (dec-3 / ac-2 / ac-3).
 *   Defaults to a bare server ctx.
 */
export async function seedStarterSpec(
  memexId: string,
  ctx: RequestCtx = { channel: "server" },
): Promise<void> {
  if (await starterSpecExists(memexId)) return;

  // The single guard that enforces system attribution regardless of caller: keep
  // only the channel (default 'server' — a missing channel is a visible defect per
  // std-32, never silently dropped), and strip any actor the caller threaded. Every
  // write below goes through THIS ctx, so actorUserId/actorName land NULL.
  const systemCtx: RequestCtx = {
    channel: ctx.channel ?? "server",
    ...(ctx.requestId !== undefined ? { requestId: ctx.requestId } : {}),
    ...(ctx.clientId !== undefined ? { clientId: ctx.clientId } : {}),
  };

  // 1. Create the Spec at draft, seeding the Overview from the fixture purpose.
  //    createdByUserId is intentionally OMITTED (undefined) — the doc is the SYSTEM's
  //    spec (documents.created_by_user_id NULL), so hasSpec (which gates on
  //    created_by_user_id = the user) can never fire on it. is_demo stays false.
  const created = await createDocDraft(
    memexId,
    STARTER_SPEC_TITLE,
    STARTER_SPEC_SECTIONS.overview,
    "spec",
    undefined,
    undefined,
    undefined, // createdByUserId — NONE; system-owned spec
    systemCtx,
  );
  const docId = created.id;

  // 2. Append the remaining narrative sections (overview is already the doc purpose).
  for (const meta of STARTER_SPEC_SECTION_ORDER) {
    if (meta.key === "overview") continue;
    await addSection(
      memexId,
      docId,
      meta.sectionType,
      STARTER_SPEC_SECTIONS[meta.key],
      meta.title,
      undefined,
      systemCtx,
    );
  }

  // 3. Genuine resolved decisions (with rejected alternatives). createDecision →
  //    resolveDecision; system-attributed (actor_user_id NULL) so they can't satisfy
  //    hasResolvedDecision (decisions.actor_user_id = the user). Resolving decisions is
  //    the work OF the specify phase, so these are coherent on a `specify` spec.
  for (const dec of STARTER_SPEC_DECISIONS) {
    const createdDec = await createDecision(
      memexId,
      docId,
      dec.title,
      dec.context,
      "human",
      systemCtx,
    );
    await resolveDecision(memexId, createdDec.id, dec.chosen, undefined, systemCtx);
  }

  // 4. Scope ACs — manager-authored outcome commitments, the right AC flavour for a
  //    spec at `specify`. Left UNVERIFIED (no synthetic test-events): an unverified
  //    scope AC is exactly correct at specify, and verification is the verify phase.
  //    system-attributed (actor_user_id NULL) so they can't satisfy hasAc / acVerified.
  for (const ac of STARTER_SPEC_ACS) {
    await createAc(
      { memexId, briefId: docId, kind: ac.kind, statement: ac.statement },
      systemCtx,
    );
  }

  // 5. One terminal write lands the 'specify' status, so the spec sits in the Specify
  //    column with its narrative on show (dec-3 revision). Goes through mutate() (std-8)
  //    so the document.updated event fires for live UIs. is_demo stays false.
  await mutate(
    systemCtx,
    { memexId, docId, entity: "document", action: "updated" },
    async () => {
      const [row] = await db
        .update(documents)
        .set({ status: "specify", statusChangedAt: new Date() })
        .where(and(eq(documents.id, docId), eq(documents.memexId, memexId)))
        .returning();
      return row;
    },
  );
}
