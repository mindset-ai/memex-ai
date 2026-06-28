import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { tagAc } from "@memex-ai-ac/vitest";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft } from "../services/documents.js";
import { mintHookKey } from "../services/hook-keys.js";
import { listCheckoutEditsForSpec } from "../services/spec-checkout.js";
import { listPresent } from "../services/presence.js";
import { stampCheckout, getCheckout } from "../services/checkout.js";
import { specCheckoutRouter } from "./spec-checkout.js";
import { app as realApp } from "../app.js";

// spec-371 t-4 — the record-only phone-home endpoint, driven through the REAL
// route against a real Postgres with a real (minted) hook key.
// ac-3  (scope): a checked-out edit is recorded to Memex against the claimed spec.
// ac-11 (dec-3): attribution is by thread_uid the hook supplies — never Mcp-Session-Id.
// ac-16 (dec-8): the response is record-only — no steering payload.
const AC_3 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-3";
const AC_11 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-11";
const AC_16 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-16";
const AC_23 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-23"; // checked_out_thread = conversation UID

const app = new Hono();
app.route("/api/spec-checkout", specCheckoutRouter);

interface Ctx {
  memexId: string;
  slug: string;
  ownerId: string;
  rawKey: string;
  docId: string;
  ref: string;
}

async function setup(prefix: string): Promise<Ctx> {
  const made = await makeTestMemexWithDevAdmin(prefix);
  const owner = await upsertUserByEmail("dev@memex.ai");
  const minted = await mintHookKey(made.memexId, "test hook", owner.id);
  const doc = await createDocDraft(
    made.memexId,
    "Phone-home spec",
    "purpose",
    "spec",
    undefined,
    undefined,
    owner.id,
  );
  return {
    memexId: made.memexId,
    slug: made.slug,
    ownerId: owner.id,
    rawKey: minted.raw,
    docId: doc.id,
    ref: `${made.slug}/main/specs/${doc.handle}`,
  };
}

function post(rawKey: string | null, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (rawKey) headers.Authorization = `Bearer ${rawKey}`;
  return app.request("/api/spec-checkout", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let ctx: Ctx;
beforeAll(async () => {
  ctx = await setup("phc");
});

describe("spec-371: record-only phone-home (ac-3, ac-11, ac-16)", () => {
  it("a valid key + accessible spec records the edit by thread_uid and acks record-only", async () => {
    tagAc(AC_3);
    tagAc(AC_11);
    tagAc(AC_16);
    const res = await post(ctx.rawKey, {
      ref: ctx.ref,
      thread_uid: "thread-phc-1",
      changed_paths: ["packages/server/src/a.ts"],
      commit_sha: "abc123",
      branch: "spec-371-spec-checkout",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ recorded: true });

    // Recorded against the spec, keyed on the thread (ac-11).
    const rows = await listCheckoutEditsForSpec(ctx.memexId, ctx.docId);
    const mine = rows.find((r) => r.threadUid === "thread-phc-1");
    expect(mine).toBeDefined();
    expect(mine?.changedPaths).toEqual(["packages/server/src/a.ts"]);
    expect(mine?.commitSha).toBe("abc123");
    expect(mine?.branch).toBe("spec-371-spec-checkout");

    // The phone-home does NOT write presence — checkout is decoupled from the
    // presence plane in the rework (dec-5); the holder surface is the columns.
    const present = await listPresent(ctx.memexId, ctx.docId);
    expect(present.some((p) => p.clientId === "thread-phc-1")).toBe(false);
  });

  it("a missing or invalid hook key is rejected 401 (the dedicated-credential gate)", async () => {
    tagAc(AC_16);
    expect(
      (await post(null, { ref: ctx.ref, thread_uid: "t", changed_paths: [] })).status,
    ).toBe(401);
    expect(
      (await post("mxh_not-a-real-key", { ref: ctx.ref, thread_uid: "t", changed_paths: [] }))
        .status,
    ).toBe(401);
  });

  it("a key for a DIFFERENT memex cannot record against this spec (cross-tenant → 401)", async () => {
    tagAc(AC_11);
    const other = await setup("phc2");
    const res = await post(other.rawKey, {
      ref: ctx.ref, // the FIRST memex's spec
      thread_uid: "thread-x",
      changed_paths: ["x.ts"],
    });
    expect(res.status).toBe(401);
  });

  it("the response never carries a steering payload — record-only (ac-16)", async () => {
    tagAc(AC_16);
    const res = await post(ctx.rawKey, {
      ref: ctx.ref,
      thread_uid: "thread-phc-2",
      changed_paths: ["b.ts"],
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(["recorded"]);
    expect(json.recorded).toBe(true);
  });

  it("the phone-home reconciles checked_out_thread to the conversation UID it carries (ac-23)", async () => {
    tagAc(AC_23);
    // The owner holds the checkout from an earlier (server-stamped) thread...
    await stampCheckout({ docId: ctx.docId, userId: ctx.ownerId, thread: "mcp-session-old" });
    // ...then an edit phone-home arrives carrying the real Claude Code conversation UID.
    const res = await post(ctx.rawKey, {
      ref: ctx.ref,
      thread_uid: "conversation-uid-xyz",
      changed_paths: ["src/a.ts"],
    });
    expect(res.status).toBe(201);
    // checked_out_thread is now the conversation UID — the join key for "return me
    // to the conversation that worked on this spec" (dec-12).
    expect((await getCheckout(ctx.docId))?.thread).toBe("conversation-uid-xyz");
  });

  // REGRESSION GUARD (the blind spot): the tests above mount specCheckoutRouter on a
  // FRESH isolated Hono, so they pass even when the route is unreachable in the real
  // app. A 3-segment flat route (`/api/spec-checkout/edit`) with no
  // `/api/:namespace/:memex` twin was silently dropped by Hono's RegExpRouter in the
  // assembled app (registered but never matched → 404). This asserts reachability
  // through the REAL app — a 404 here means the endpoint is dead in production.
  it("the endpoint is REACHABLE through the fully-assembled app (not just in isolation)", async () => {
    tagAc(AC_3);
    tagAc(AC_16);
    const res = await realApp.request("/api/spec-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer mxh_unreachable-probe" },
      body: JSON.stringify({ ref: "x/y/specs/spec-1", thread_uid: "t", changed_paths: [] }),
    });
    // 401 = route matched and hit the hook-key auth gate. 404 = route shadowed/dropped.
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});
