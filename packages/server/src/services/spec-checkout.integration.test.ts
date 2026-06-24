import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import {
  recordCheckoutEdit,
  listCheckoutEditsForSpec,
  claimSpecPresence,
  releaseSpecPresence,
} from "./spec-checkout.js";
import { listPresent } from "./presence.js";

// spec-371 t-2 — the record-only edit ledger + footprint join key.
// ac-11 (dec-8): a phone-home records the edit (durable event + footprint join key).
const AC_11 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-11";

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
      branch: "spec-371-spec-checkout",
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
    expect(rows[0].branch).toBe("spec-371-spec-checkout");
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
    expect(saved.changedPaths).toEqual(["README.md"]);
  });
});

// ac-13 (dec-5): a successful claim writes a presence record (who/which-spec/when);
// no hard lock, no eviction — claim/unclaim just toggle a soft presence marker.
// ac-6 (scope): an active checkout is VISIBLE as presence on the existing plane.
const AC_13 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-13";
const AC_6 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-6";

describe("spec-checkout: claim / unclaim presence (spec-371 ac-13)", () => {
  it("a successful claim writes a presence record on the spec, with nobody else present", async () => {
    tagAc(AC_13);
    tagAc(AC_6);
    const memexId = await makeTestMemex("cl");
    const user = await upsertUserByEmail("dev@memex.ai");
    const docId = await makeTestSpec(memexId);

    const { othersPresent } = await claimSpecPresence({
      memexId,
      docId,
      actorUserId: user.id,
      actorName: "Dev",
      actorKind: "mcp_agent",
      channel: "mcp",
      clientId: "thread-sess-1",
    });
    // Soft lock: a fresh spec has no other holder.
    expect(othersPresent).toEqual([]);

    const present = await listPresent(memexId, docId);
    const mine = present.find(
      (p) => p.actorUserId === user.id && p.clientId === "thread-sess-1",
    );
    expect(mine).toBeDefined();
    expect(mine?.docId).toBe(docId);
  });

  it("unclaim clears the presence record so the thread reads as free again", async () => {
    tagAc(AC_13);
    const memexId = await makeTestMemex("cl");
    const user = await upsertUserByEmail("dev@memex.ai");
    const docId = await makeTestSpec(memexId);

    await claimSpecPresence({
      memexId,
      docId,
      actorUserId: user.id,
      actorName: "Dev",
      actorKind: "mcp_agent",
      channel: "mcp",
      clientId: "thread-sess-2",
    });
    expect(
      (await listPresent(memexId, docId)).some((p) => p.clientId === "thread-sess-2"),
    ).toBe(true);

    await releaseSpecPresence({
      docId,
      actorUserId: user.id,
      channel: "mcp",
      clientId: "thread-sess-2",
    });
    expect(
      (await listPresent(memexId, docId)).some((p) => p.clientId === "thread-sess-2"),
    ).toBe(false);
  });
});
