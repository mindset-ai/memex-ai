import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { recordCheckoutEdit, listCheckoutEditsForSpec } from "./spec-checkout.js";
import { listPresent } from "./presence.js";
import {
  CHECKOUT_COLLISION_WINDOW_MS,
  getCheckout,
  collisionAgainst,
  stampCheckout,
  releaseCheckout,
} from "./checkout.js";

const NS = "mindset-prod/memex-building-itself/specs/spec-371/acs";
const AC_11 = `${NS}/ac-11`; // the phone-home records the edit (durable join key)
const AC_13 = `${NS}/ac-13`; // a checkout stamps the columns, NOT presence
const AC_6 = `${NS}/ac-6`; // who holds it is recorded ON the spec, distinct from presence
const AC_21 = `${NS}/ac-21`; // the collision window is one named constant
const AC_22 = `${NS}/ac-22`; // explicit claim always takes over, never blocks

async function makeTestSpec(memexId: string, handle = "spec-1"): Promise<string> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle, title: "Test Spec", docType: "spec" })
    .returning({ id: documents.id });
  return doc.id;
}

describe("spec-checkout: recordCheckoutEdit ledger (spec-371 ac-11)", () => {
  it("records an edit with paths + git footprint and reads it back as the join key", async () => {
    tagAc(AC_11);
    const memexId = await makeTestMemex("ck");
    const user = await upsertUserByEmail("dev@memex.ai");
    const docId = await makeTestSpec(memexId);

    const saved = await recordCheckoutEdit({
      memexId,
      docId,
      threadUid: "thread-abc-123",
      changedPaths: ["packages/server/src/foo.ts", "packages/server/src/foo.test.ts"],
      commitSha: "deadbeefcafe",
      branch: "spec-371-checkout-rework",
      actorUserId: user.id,
    });
    expect(saved.threadUid).toBe("thread-abc-123");
    expect(saved.changedPaths).toEqual([
      "packages/server/src/foo.ts",
      "packages/server/src/foo.test.ts",
    ]);

    const rows = await listCheckoutEditsForSpec(memexId, docId);
    expect(rows).toHaveLength(1);
    expect(rows[0].commitSha).toBe("deadbeefcafe");
    expect(rows[0].docId).toBe(docId);
    expect(rows[0].actorUserId).toBe(user.id);
  });

  it("accepts a record with no git footprint (commit/branch nullable)", async () => {
    tagAc(AC_11);
    const memexId = await makeTestMemex("ck");
    const docId = await makeTestSpec(memexId);

    const saved = await recordCheckoutEdit({
      memexId,
      docId,
      threadUid: "thread-no-git",
      changedPaths: ["README.md"],
    });
    expect(saved.commitSha).toBeNull();
    expect(saved.branch).toBeNull();
    expect(saved.actorUserId).toBeNull();
  });
});

describe("spec-checkout: the durable checkout record (spec-371 ac-13, ac-6, ac-21, ac-22)", () => {
  it("stampCheckout writes checked_out_by/at/thread on the document — and writes NO presence row (ac-13, ac-6)", async () => {
    tagAc(AC_13);
    tagAc(AC_6);
    const memexId = await makeTestMemex("co");
    const user = await upsertUserByEmail("dev@memex.ai");
    const docId = await makeTestSpec(memexId);

    await stampCheckout({ docId, userId: user.id, thread: "conv-abc" });

    const state = await getCheckout(docId);
    expect(state?.userId).toBe(user.id);
    expect(state?.thread).toBe("conv-abc"); // the conversation UID lands here (dec-12)
    expect(state?.at).toBeInstanceOf(Date);
    // The decoupling from presence: a checkout must NOT have written the presence plane.
    expect(await listPresent(memexId, docId)).toHaveLength(0);
  });

  it("a new holder supersedes the prior; releaseCheckout frees ONLY the current holder (ac-13)", async () => {
    tagAc(AC_13);
    const memexId = await makeTestMemex("co");
    const a = await upsertUserByEmail("a@example.com");
    const b = await upsertUserByEmail("b@example.com");
    const docId = await makeTestSpec(memexId);

    await stampCheckout({ docId, userId: a.id, thread: "ta" });
    await stampCheckout({ docId, userId: b.id, thread: "tb" }); // supersede
    expect((await getCheckout(docId))?.userId).toBe(b.id);

    await releaseCheckout(docId, a.id); // a's stale unclaim must NOT evict b
    expect((await getCheckout(docId))?.userId).toBe(b.id);
    await releaseCheckout(docId, b.id); // the holder releases → free
    expect((await getCheckout(docId))?.userId).toBeNull();
  });

  it("collisionAgainst: free / mine / stale → null; another user within the window → collision (ac-21)", () => {
    tagAc(AC_21);
    const now = 1_700_000_000_000;
    const within = new Date(now - 60_000); // 1 min ago
    const stale = new Date(now - CHECKOUT_COLLISION_WINDOW_MS - 1);
    expect(collisionAgainst(null, "u", now)).toBeNull(); // free
    expect(collisionAgainst({ userId: "u", at: within, thread: null }, "u", now)).toBeNull(); // mine
    expect(collisionAgainst({ userId: "other", at: stale, thread: null }, "u", now)).toBeNull(); // stale → takeover ok
    const c = collisionAgainst({ userId: "other", at: within, thread: null }, "u", now);
    expect(c?.holderUserId).toBe("other");
    expect(CHECKOUT_COLLISION_WINDOW_MS).toBe(10 * 60 * 1000); // one named constant, default 10 min
  });

  it("explicit takeover always overwrites the holder, even inside the window — never blocked (ac-22)", async () => {
    tagAc(AC_22);
    const memexId = await makeTestMemex("co");
    const pete = await upsertUserByEmail("pete@example.com");
    const me = await upsertUserByEmail("me@example.com");
    const docId = await makeTestSpec(memexId);

    await stampCheckout({ docId, userId: pete.id, thread: "pete-conv" }); // pete holds it, just now
    // there IS a live collision for me...
    expect(collisionAgainst(await getCheckout(docId), me.id)?.holderUserId).toBe(pete.id);
    // ...but an explicit claim takes it over unconditionally (the handler never throws on this).
    await stampCheckout({ docId, userId: me.id, thread: "my-conv" });
    expect((await getCheckout(docId))?.userId).toBe(me.id);
  });
});
