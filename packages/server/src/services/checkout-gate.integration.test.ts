import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { enforceCheckoutGate } from "./checkout-gate.js";
import { getCheckout, stampCheckout, CHECKOUT_COLLISION_WINDOW_MS } from "./checkout.js";
import type { ToolCtx } from "../agent/handlers/tool-contract.js";

const NS = "mindset-prod/memex-building-itself/specs/spec-371/acs";
const AC_20 = `${NS}/ac-20`; // the gate decision tree
const AC_5 = `${NS}/ac-5`; // implicit checkout, no nudge
const AC_7 = `${NS}/ac-7`; // never hard-blocked; only the collision fails

async function makeTestSpec(memexId: string, handle = "spec-1"): Promise<string> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: "Gate Spec", docType: "spec" })
    .returning({ id: documents.id });
  return doc.id;
}

// Minimal ToolCtx whose resolveRef returns the given doc (no real ref grammar
// needed — the gate only reads resolved.doc.{id,docType} + ctx.userId/sessionId).
function ctxFor(userId: string, sessionId: string, docId: string, docType = "spec"): ToolCtx {
  return {
    userId,
    sessionId,
    resolveRef: async () => ({
      memexId: "m",
      doc: { id: docId, docType },
      entity: { kind: "document" },
    }),
  } as unknown as ToolCtx;
}

const ago = (ms: number) => new Date(Date.now() - ms);

describe("checkout gate (spec-371 ac-20, ac-5, ac-7)", () => {
  it("free spec → implicit checkout, no throw, no nudge (ac-5, ac-20)", async () => {
    tagAc(AC_5);
    tagAc(AC_20);
    const memexId = await makeTestMemex("g");
    const u = await upsertUserByEmail("dev@memex.ai");
    const docId = await makeTestSpec(memexId);
    await enforceCheckoutGate("update_section", { ref: "spec-1" }, ctxFor(u.id, "conv-1", docId));
    const s = await getCheckout(docId);
    expect(s?.userId).toBe(u.id);
    expect(s?.thread).toBe("conv-1");
  });

  it("held by me → refresh to this conversation, no throw (ac-20)", async () => {
    tagAc(AC_20);
    const memexId = await makeTestMemex("g");
    const u = await upsertUserByEmail("dev@memex.ai");
    const docId = await makeTestSpec(memexId);
    await stampCheckout({ docId, userId: u.id, thread: "old-conv", now: ago(5 * 60_000) });
    await enforceCheckoutGate("update_doc", { ref: "spec-1" }, ctxFor(u.id, "new-conv", docId));
    expect((await getCheckout(docId))?.thread).toBe("new-conv");
  });

  it("held by another user but STALE → take over, no throw (ac-20)", async () => {
    tagAc(AC_20);
    const memexId = await makeTestMemex("g");
    const pete = await upsertUserByEmail("pete@example.com");
    const me = await upsertUserByEmail("me@example.com");
    const docId = await makeTestSpec(memexId);
    await stampCheckout({ docId, userId: pete.id, thread: "pete", now: ago(CHECKOUT_COLLISION_WINDOW_MS + 60_000) });
    await enforceCheckoutGate("create_decision", { ref: "spec-1" }, ctxFor(me.id, "mine", docId));
    expect((await getCheckout(docId))?.userId).toBe(me.id);
  });

  it("held by another user WITHIN the window → agent-actionable takeover error, no write (ac-20, ac-7)", async () => {
    tagAc(AC_20);
    tagAc(AC_7);
    const memexId = await makeTestMemex("g");
    const pete = await upsertUserByEmail("pete@example.com");
    const me = await upsertUserByEmail("me@example.com");
    const docId = await makeTestSpec(memexId);
    await stampCheckout({ docId, userId: pete.id, thread: "pete", now: ago(8 * 60_000) });
    await expect(
      enforceCheckoutGate("update_section", { ref: "spec-1" }, ctxFor(me.id, "mine", docId)),
    ).rejects.toThrow(/checked this spec out 8 minutes ago[\s\S]*claim_spec/);
    // the holder is unchanged — the blocked mutation did NOT take it over
    expect((await getCheckout(docId))?.userId).toBe(pete.id);
  });

  it("a non-gated tool (read / explicit claim) is never gated — never blocked (ac-7)", async () => {
    tagAc(AC_7);
    const memexId = await makeTestMemex("g");
    const pete = await upsertUserByEmail("pete@example.com");
    const me = await upsertUserByEmail("me@example.com");
    const docId = await makeTestSpec(memexId);
    await stampCheckout({ docId, userId: pete.id, thread: "pete", now: new Date() }); // pete holds it right now
    // get_doc (read) and claim_spec (explicit checkout) are NOT in the gate set →
    // no throw and no implicit checkout stamped.
    await enforceCheckoutGate("get_doc", { ref: "spec-1" }, ctxFor(me.id, "mine", docId));
    await enforceCheckoutGate("claim_spec", { ref: "spec-1" }, ctxFor(me.id, "mine", docId));
    expect((await getCheckout(docId))?.userId).toBe(pete.id);
  });
});
