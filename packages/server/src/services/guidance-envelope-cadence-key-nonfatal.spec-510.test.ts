// spec-510 — the SEAT survives a cadence key that cannot be resolved.
// Round-1 review of PR #740, M-3 — the half the review did not name.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HAZARD. `composeGuidanceEnvelope` awaits `ctx.cadenceKey?.()`. On the
// in-app surface that thunk is `conversationCadenceKey` → `conversationIdFor`,
// which READS THE DATABASE. An unguarded throw there lands in the seat's own
// catch, which returns `compose(withLead(undefined), undefined)` — a footer
// with no guidance, no handoff, no acceptance-criteria nag, no activity block
// and no state line.
//
// So a transient on a lookup whose ONLY job is to pick a suppression key would
// have silently removed every steer from the response. The documented contract
// is the opposite: a key that cannot be resolved means "no key", and no key
// means emit guidance IN FULL.
//
// WHY THIS FILE EXISTS SEPARATELY. Its sibling
// `guidance-cadence.nonfatal.spec-510.test.ts` mocks `./session-claims.js` to
// force the claim loop to fail. That mock is file-wide, and the seat's own
// dependencies reach the same module — so a seat test living there composes
// against stubs and produces an empty footer for a reason that has nothing to
// do with the guard. Measured, not guessed: the control assertion below failed
// in that file with a healthy key, which is what sent this test here.
//
// THE CONTROL IS LOAD-BEARING. An empty footer proves nothing on its own; the
// fixture might simply never produce one. Two earlier fixtures here did exactly
// that — a personal namespace, and a draft-phase Spec — and both would have
// read as "the guard failed". The control runs the same call with a healthy key
// FIRST and refuses to interpret anything until it sees a real footer.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
} from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { composeGuidanceEnvelope } from "../agent/handlers/guidance-envelope.js";
import { GUIDANCE_CADENCE_FLAG } from "./guidance-cadence.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-9";

const createdUserIds: string[] = [];
const createdNamespaceIds: string[] = [];

afterAll(async () => {
  if (createdNamespaceIds.length) {
    await db
      .delete(namespaces)
      .where(inArray(namespaces.id, createdNamespaceIds))
      .catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

/** An ORG memex with an administrator membership — the shape spec-219's own
 *  envelope test uses, and the one that actually composes a footer. */
async function seedSpecInBuild(): Promise<{ userId: string; memexId: string; docId: string }> {
  const sub = `cadence-key-nf-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const [user] = await db
    .insert(users)
    .values({ email: `${sub}@memex.ai`, emailVerifiedAt: new Date() } as typeof users.$inferInsert)
    .returning();
  createdUserIds.push(user.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  createdNamespaceIds.push(ns.id);
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${sub}` })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  await db.insert(orgMemberships).values({ userId: user.id, orgId: org.id, role: "administrator" });

  const doc = await createDocDraft(mx.id, "Cadence Key Nonfatal", "Purpose.", "spec");
  // `build`, not draft — a draft Spec composes no phase-guidance footer.
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
  return { userId: user.id, memexId: mx.id, docId: doc.id };
}

describe("spec-510 — a cadence key that throws must not empty the footer", () => {
  it("the seat degrades to full guidance instead of losing every steer", async () => {
    tagAc(AC_9);
    const previous = process.env[GUIDANCE_CADENCE_FLAG];
    process.env[GUIDANCE_CADENCE_FLAG] = "1";
    try {
      const { userId, memexId, docId } = await seedSpecInBuild();
      // `workspaceUrl` is not optional on the verbose path — the seat calls it
      // to compose the handoff. Omitting it threw INSIDE the seat's catch and
      // produced the same empty footer the guard is about, which is precisely
      // the confusion the control assertion exists to prevent.
      const ctx = (key: () => Promise<string | undefined>) =>
        ({
          verbose: true,
          userId,
          toolName: "get_doc",
          workspaceUrl: () => "https://memex.ai/test-ns/main",
          cadenceKey: key,
        }) as never;

      // ── Control: a healthy resolver produces a real footer here ───────────
      const control = await composeGuidanceEnvelope(
        memexId,
        docId,
        ctx(() => Promise.resolve(undefined)),
      );
      expect(
        control.footer,
        "This fixture composes no footer even with a healthy key, so the " +
          "assertion below could not distinguish a working guard from a broken " +
          "one. Fix the fixture, not the code.",
      ).toBeTruthy();

      // ── The guard: the same call with a resolver that rejects ────────────
      const broken = await composeGuidanceEnvelope(
        memexId,
        docId,
        ctx(() => Promise.reject(new Error("pool timeout"))),
      );
      expect(
        broken.footer,
        "A failed cadence-key lookup reached the seat's catch and returned an " +
          "EMPTY footer — no guidance, no handoff, no AC nag, no state line. An " +
          "unresolvable key means 'no key', and no key means emit IN FULL.",
      ).toBeTruthy();

      // Not merely non-empty: the degrade must land on the DOCUMENTED fallback —
      // byte-for-byte what a session with no key receives.
      //
      // ⚠ THE SUBSTRING VERSION OF THIS WAS TOO WEAK, and I wrote it (PR #740
      // round-2 → round-3, M-14). This file's header describes the defect as a
      // footer missing FIVE things — guidance, handoff, AC nag, activity block,
      // state line. Equality against the healthy control checks all five; a
      // substring on one guidance block checks one, and this test is the only
      // guard for that half of M-3. A regression that kept the guidance but
      // dropped the handoff would have passed.
      //
      // The flake it was trading against is real but tiny: the activity block
      // carries a relative-time label (`agoLabel` — "just now", "Nm ago", "Nh
      // ago", "Nd ago") that changes under two calls milliseconds apart on a
      // fraction of a percent of runs. The first boundary is at 30 SECONDS, not
      // 60: `agoLabel` uses `Math.round(ms / 60000)`, so 30_000ms already rounds
      // to 1 and renders "1m ago" (PR #740 round-4 — I had this wrong once).
      // Every later rounding step is a boundary too, and the regex covers them.
      // Normalising that ONE volatile segment keeps the full reach and removes
      // the window, which is better than choosing between them.
      const STATIC_MARKER = "classify-and-consult";
      const stable = (s: string | undefined): string =>
        (s ?? "").replace(/just now|\d+[mhd] ago/g, "<t>");

      // Kept from the substring version, which was a genuine improvement over
      // `toBeTruthy()`: this proves the fixture composes GUIDANCE, not merely
      // some footer, so the equality below is comparing something meaningful.
      expect(control.footer).toContain(STATIC_MARKER);
      expect(
        stable(broken.footer),
        "The degrade landed somewhere other than the documented 'emit in full' " +
          "fallback. Compared against the healthy control so this covers every " +
          "part of the footer — guidance, handoff, AC nag, activity, state line " +
          "— not just the guidance block.",
      ).toBe(stable(control.footer));
    } finally {
      if (previous === undefined) delete process.env[GUIDANCE_CADENCE_FLAG];
      else process.env[GUIDANCE_CADENCE_FLAG] = previous;
    }
  });
});
