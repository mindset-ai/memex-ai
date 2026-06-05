import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../db/connection.js";
import { documents } from "../../db/schema.js";
import {
  assertDocBelongsToMemex,
  assertUserMember,
} from "./memex-ownership.js";
import { ForbiddenError, NotFoundError } from "../../types/errors.js";
import { makeTestMemexWithDevAdmin, makeTestMemex } from "../test-helpers.js";
import { upsertUserByEmail } from "../users.js";

describe("assertDocBelongsToMemex", () => {
  it("returns the doc when it belongs to the account", async () => {
    const memexId = await makeTestMemex("aob");
    const [doc] = await db
      .insert(documents)
      // Explicit docType: the DB column still defaults to the pre-b-105
      // legacy doc-type noun (migration drift), and a leaked legacy-typed row
      // trips the b105-ac-coverage invariant when that test runs after this one.
      .values({ memexId: memexId, handle: "doc-1", title: "T", docType: "spec" })
      .returning();
    const result = await assertDocBelongsToMemex(doc.id, memexId);
    expect(result.id).toBe(doc.id);
    expect(result.memexId).toBe(memexId);
  });

  it("throws NotFoundError (not Forbidden) when the doc belongs to another account", async () => {
    const ownerId = await makeTestMemex("aob-owner");
    const otherId = await makeTestMemex("aob-other");
    const [doc] = await db
      .insert(documents)
      // Explicit docType — see the note above on the legacy doc-type default.
      .values({ memexId: ownerId, handle: "doc-1", title: "T", docType: "spec" })
      .returning();
    await expect(assertDocBelongsToMemex(doc.id, otherId)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when the doc id doesn't exist", async () => {
    const memexId = await makeTestMemex("aob");
    await expect(
      assertDocBelongsToMemex("00000000-0000-0000-0000-000000000000", memexId),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("assertUserMember", () => {
  let memexId: string;
  beforeAll(async () => {
    const seeded = await makeTestMemexWithDevAdmin("aum");
    memexId = seeded.memexId;
  });

  it("resolves silently for an active member", async () => {
    const dev = await upsertUserByEmail("dev@memex.ai");
    await expect(assertUserMember(dev.id, memexId)).resolves.toBeUndefined();
  });

  it("throws ForbiddenError for a non-member", async () => {
    const stranger = await upsertUserByEmail(`stranger-${Date.now()}@example.com`);
    await expect(assertUserMember(stranger.id, memexId)).rejects.toThrow(ForbiddenError);
  });
});
