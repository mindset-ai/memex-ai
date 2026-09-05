// spec-538 t-15 (ac-34) — the drift guard on ENVELOPE_SEAT_ALLOWANCE_CHARS.
//
// t-15 made `formatFullDocState` reserve its own envelope, computed from inputs
// it holds: `toNudge` (pure, total) plus `nudge.fullHandoff` when the seat has
// resolved one. Only ONE term is a reserve rather than a computation — what
// `composeGuidanceEnvelope` adds AFTER the handler returns:
//
//   the FOOTER_DELIMITER · the one-line dynamic state · STEER_BY_TOOL ·
//   spec-249's status overview · spec-521 dec-5's supersession lead line
//
// ENVELOPE_SEAT_ALLOWANCE_CHARS = 3,000 stands in for exactly those, and until
// this file nothing checked it. That is the hole t-15's own checklist recorded as
// open: "a bound anything can escape is not a bound" is the argument this Spec
// makes about everyone else's numbers, and it applies to ours.
//
// WHY THE HANDOFF IS NOT AT RISK, and therefore not asserted here: the render
// measures `nudge.fullHandoff.length` — the actual string the seat handed it — so
// that term cannot drift from what is emitted. It is exact by construction. The
// seat's own additions are the only estimate, so they are the only thing to pin.
//
// WHY AN INTEGRATION TEST: `composeGuidanceEnvelope` reads the doc, the phase and
// the delivery claim from the database. A unit test would have to fake the thing
// it is trying to measure.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import {
  BASE_SCAFFOLD,
  toNudge,
  toHandoffEssence,
  type SpecPhase,
} from "@memex/shared";
import { db } from "../db/connection.js";
import { memexes, documents, docSections, users } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { ENVELOPE_SEAT_ALLOWANCE_CHARS } from "../mcp/response-budget.js";
import { composeGuidanceEnvelope, type ToolCtx } from "./tool-specs.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-538/acs/ac-${n}`;

const cleanup = { memexes: [] as string[], docs: [] as string[], users: [] as string[] };

afterAll(async () => {
  if (cleanup.docs.length) {
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

/** The verbose read path — the branch that carries the full phase footer. */
function verboseCtx(userId: string): ToolCtx {
  return {
    userId,
    verbose: true,
    workspaceUrl: async () => "https://test.example",
    footerSlot: {},
  } as unknown as ToolCtx;
}

describe("the seat allowance is a bound, not a hope (ac-34)", () => {
  it("covers what composeGuidanceEnvelope actually adds, in every phase", async () => {
    tagAc(AC(34));

    const [u] = await db
      .insert(users)
      .values({
        email: `s538env-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai`,
      } as never)
      .returning();
    cleanup.users.push(u.id);
    const memexId = await makeTestMemex("s538env");
    cleanup.memexes.push(memexId);

    const doc = await createDocDraft(
      memexId,
      "Envelope allowance fixture",
      "Overview body.",
      "spec",
      undefined,
      undefined,
      u.id,
      { actorUserId: u.id, channel: "mcp" },
    );
    cleanup.docs.push(doc.id);

    const phases: SpecPhase[] = ["draft", "specify", "build", "verify", "done"];
    const observed: string[] = [];

    for (const phase of phases) {
      await db
        .update(documents)
        .set({ status: phase })
        .where(eq(documents.id, doc.id));

      // Compose twice. The full handoff is claimed once per (user, session, spec,
      // phase), so the second call carries the compressed essence instead — which
      // isolates the term this test exists to bound. Taking the SMALLER of the two
      // rather than assuming an order keeps this robust to the claim's mechanics.
      const first = await composeGuidanceEnvelope(memexId, doc.id, verboseCtx(u.id));
      const second = await composeGuidanceEnvelope(memexId, doc.id, verboseCtx(u.id));
      const lengthOf = (e: { header?: string; footer?: string }) =>
        (e.header?.length ?? 0) + (e.footer?.length ?? 0);
      const essenceShaped = Math.min(lengthOf(first), lengthOf(second));

      // What the render would compute for this phase, by the same formula, minus
      // the allowance — i.e. the part it KNOWS.
      const known =
        toNudge({ dataset: BASE_SCAFFOLD, phase }).length +
        (toHandoffEssence(BASE_SCAFFOLD, phase) ?? "").length;

      const seatAdditions = essenceShaped - known;
      observed.push(
        `${phase}: composed ${essenceShaped}, known ${known}, seat +${seatAdditions}`,
      );

      expect(
        seatAdditions,
        `phase "${phase}": the seat added ${seatAdditions} chars beyond what the ` +
          `render can compute, against an allowance of ${ENVELOPE_SEAT_ALLOWANCE_CHARS}. ` +
          `If this is a deliberate growth, raise the allowance AND re-derive ` +
          `RESPONSE_BUDGET_CHARS with it. Observed: ${observed.join(" | ")}`,
      ).toBeLessThanOrEqual(ENVELOPE_SEAT_ALLOWANCE_CHARS);
    }

    // The fixture has to have actually exercised the seat, or the loop above
    // proves nothing — the same trap as ac-4's task-less fixture (s-5 §3).
    expect(observed).toHaveLength(phases.length);
    expect(
      observed.some((o) => !o.includes("composed 0,")),
      `every phase composed an empty envelope — the fixture did not exercise the ` +
        `seat. Observed: ${observed.join(" | ")}`,
    ).toBe(true);
  });
});
