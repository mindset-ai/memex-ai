import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { mintHookKey } from "../services/hook-keys.js";
import { listCheckoutEditsForSpec } from "../services/spec-checkout.js";
import { specCheckoutRouter } from "./spec-checkout.js";

// spec-430 ac-5 — the graduation guarantee: ONE user-scoped mxh_ key, minted once,
// records checkout edits against EVERY memex its creator belongs to (personal + any
// org, present or future), with ZERO new authentication. This is the whole payoff of
// dec-1's user-scoping: no per-memex re-mint, no second sign-in on graduation.
const AC_5 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-5";

const app = new Hono();
app.route("/api/spec-checkout", specCheckoutRouter);

function post(rawKey: string, body: unknown) {
  return app.request("/api/spec-checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${rawKey}` },
    body: JSON.stringify(body),
  });
}

interface MemexCtx {
  memexId: string;
  slug: string;
  docId: string;
  ref: string;
}

async function makeMemexWithSpec(prefix: string, ownerId: string): Promise<MemexCtx> {
  const made = await makeTestMemexWithDevAdmin(prefix);
  const doc = await createDocDraft(
    made.memexId,
    "Graduation spec",
    "purpose",
    "spec",
    undefined,
    undefined,
    ownerId,
  );
  return {
    memexId: made.memexId,
    slug: made.slug,
    docId: doc.id,
    ref: `${made.slug}/main/specs/${doc.handle}`,
  };
}

describe("spec-430 ac-5: one user-scoped key records across every memex its owner belongs to", () => {
  let rawKey: string;
  let a: MemexCtx;
  let b: MemexCtx;

  beforeAll(async () => {
    // dev@memex.ai is made an admin of BOTH memexes by makeTestMemexWithDevAdmin.
    const dev = await upsertUserByEmail("dev@memex.ai");
    a = await makeMemexWithSpec("grad-a", dev.id);
    b = await makeMemexWithSpec("grad-b", dev.id);
    // ONE key, minted once at the user level (no memex anywhere); the row is
    // user-scoped (memexId null).
    const minted = await mintHookKey("graduation hook", dev.id);
    expect(minted.row.memexId).toBeNull();
    rawKey = minted.raw;
  });

  it("records against memex A's spec", async () => {
    tagAc(AC_5);
    const res = await post(rawKey, {
      ref: a.ref,
      thread_uid: "grad-thread-a",
      changed_paths: ["packages/server/src/a.ts"],
    });
    expect(res.status).toBe(201);
    const rows = await listCheckoutEditsForSpec(a.memexId, a.docId);
    expect(rows.some((r) => r.threadUid === "grad-thread-a")).toBe(true);
  });

  it("records against memex B's spec — the SAME key, zero new auth (graduation)", async () => {
    tagAc(AC_5);
    const res = await post(rawKey, {
      ref: b.ref,
      thread_uid: "grad-thread-b",
      changed_paths: ["packages/server/src/b.ts"],
    });
    expect(res.status).toBe(201);
    const rows = await listCheckoutEditsForSpec(b.memexId, b.docId);
    expect(rows.some((r) => r.threadUid === "grad-thread-b")).toBe(true);
  });
});
