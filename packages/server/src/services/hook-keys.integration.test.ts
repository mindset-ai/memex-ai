import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import {
  mintHookKey,
  verifyHookKey,
  revokeHookKey,
  generateRawHookKey,
} from "./hook-keys.js";

// spec-371 t-1 — scoped hook credential, DB round-trips.
// ac-14 (dec-6): a dedicated credential minted at install; mint → verify works,
// and a revoked / unknown / wrong-prefix key never authorises.
const AC_14 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-14";

describe("hook-keys: mint / verify / revoke (spec-371 ac-14)", () => {
  it("mint → verify round-trips to the same unrevoked row, scoped to its memex", async () => {
    tagAc(AC_14);
    const memexId = await makeTestMemex("hk");
    const user = await upsertUserByEmail("dev@memex.ai");

    const minted = await mintHookKey(memexId, "spec-371 install", user.id);
    expect(minted.raw.startsWith("mxh_")).toBe(true);
    expect(minted.row.memexId).toBe(memexId);

    const found = await verifyHookKey(minted.raw);
    expect(found?.id).toBe(minted.row.id);
    expect(found?.memexId).toBe(memexId);
    expect(found?.revokedAt).toBeNull();
  });

  it("a revoked key never verifies again", async () => {
    tagAc(AC_14);
    const memexId = await makeTestMemex("hk");
    const user = await upsertUserByEmail("dev@memex.ai");
    const minted = await mintHookKey(memexId, "to-revoke", user.id);

    expect(await verifyHookKey(minted.raw)).not.toBeNull();
    const revoked = await revokeHookKey(minted.row.id, memexId);
    expect(revoked?.id).toBe(minted.row.id);
    expect(await verifyHookKey(minted.raw)).toBeNull();
  });

  it("an unknown key and a wrong-prefix string (e.g. a mxt_ PAT) both fail closed", async () => {
    tagAc(AC_14);
    // Never minted — correct shape, no matching hash.
    expect(await verifyHookKey(generateRawHookKey())).toBeNull();
    // A user PAT must NOT authenticate the hook channel (dec-6).
    expect(await verifyHookKey("mxt_some-personal-access-token")).toBeNull();
    // Garbage.
    expect(await verifyHookKey("not-a-key")).toBeNull();
  });
});
