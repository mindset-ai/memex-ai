import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
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
  it("mint → verify round-trips to the same unrevoked row; the key is USER-scoped (memexId null, spec-430 dec-1)", async () => {
    tagAc(AC_14);
    const user = await upsertUserByEmail("dev@memex.ai");

    const minted = await mintHookKey("spec-371 install", user.id);
    expect(minted.raw.startsWith("mxh_")).toBe(true);
    // spec-430 dec-1: minted keys are user-scoped — no home memex on the row.
    expect(minted.row.memexId).toBeNull();
    expect(minted.row.createdByUserId).toBe(user.id);

    const found = await verifyHookKey(minted.raw);
    expect(found?.id).toBe(minted.row.id);
    expect(found?.memexId).toBeNull();
    expect(found?.revokedAt).toBeNull();
  });

  it("a revoked key never verifies again (owner-scoped revoke, spec-430 dec-1)", async () => {
    tagAc(AC_14);
    const user = await upsertUserByEmail("dev@memex.ai");
    const minted = await mintHookKey("to-revoke", user.id);

    expect(await verifyHookKey(minted.raw)).not.toBeNull();
    const revoked = await revokeHookKey(minted.row.id, user.id);
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
