import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, shareTokens } from "../db/schema.js";
import { NotFoundError } from "../types/errors.js";
import { createDocDraft } from "./documents.js";
import {
  createShareToken,
  listShareTokensForDoc,
  revokeShareToken,
  getSharedDocumentByToken,
  ShareTokenError,
} from "./share-tokens.js";
import { makeTestMemex } from "./test-helpers.js";

let accountA: string;
let accountB: string;

beforeAll(async () => {
  accountA = await makeTestMemex("sta");
  accountB = await makeTestMemex("stb");
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, [accountA, accountB])).catch(() => {});
});

describe("createShareToken", () => {
  it("creates a share token with a random UUID for a doc in the caller's account", async () => {
    const doc = await createDocDraft(accountA, "Share Doc", "Purpose");

    const share = await createShareToken(accountA, doc.id);
    expect(share.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(share.documentId).toBe(doc.id);
    expect(share.revoked).toBe(false);
  });

  it("rejects create for a doc belonging to another account", async () => {
    const docA = await createDocDraft(accountA, "A Only", "Purpose");
    await expect(createShareToken(accountB, docA.id)).rejects.toThrow(NotFoundError);
  });

  it("generates unique tokens across calls", async () => {
    const doc = await createDocDraft(accountA, "Unique", "Purpose");
    const a = await createShareToken(accountA, doc.id);
    const b = await createShareToken(accountA, doc.id);
    expect(a.token).not.toBe(b.token);
  });
});

describe("listShareTokensForDoc", () => {
  it("returns only active (non-revoked) tokens for the doc", async () => {
    const doc = await createDocDraft(accountA, "List Shares", "Purpose");
    const active = await createShareToken(accountA, doc.id);
    const later = await createShareToken(accountA, doc.id);
    await db
      .update(shareTokens)
      .set({ revoked: true })
      .where(eq(shareTokens.id, later.id));

    const list = await listShareTokensForDoc(accountA, doc.id);
    expect(list.map((s) => s.id)).toEqual([active.id]);
  });

  it("rejects list for a doc in another account (no enumeration)", async () => {
    const docA = await createDocDraft(accountA, "Secret", "Purpose");
    await createShareToken(accountA, docA.id);
    await expect(listShareTokensForDoc(accountB, docA.id)).rejects.toThrow(NotFoundError);
  });
});

describe("revokeShareToken", () => {
  it("marks a share as revoked", async () => {
    const doc = await createDocDraft(accountA, "Revoke Me", "Purpose");
    const share = await createShareToken(accountA, doc.id);

    const result = await revokeShareToken(accountA, share.id);
    expect(result.revoked).toBe(true);
  });

  it("is idempotent for already-revoked shares", async () => {
    const doc = await createDocDraft(accountA, "Already Revoked", "Purpose");
    const share = await createShareToken(accountA, doc.id);
    await revokeShareToken(accountA, share.id);
    const result = await revokeShareToken(accountA, share.id);
    expect(result.revoked).toBe(true);
  });

  it("rejects revoke from a different account", async () => {
    const doc = await createDocDraft(accountA, "Not Yours", "Purpose");
    const share = await createShareToken(accountA, doc.id);
    await expect(revokeShareToken(accountB, share.id)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError for unknown shareId", async () => {
    await expect(
      revokeShareToken(accountA, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });
});

describe("getSharedDocumentByToken (public)", () => {
  it("returns doc + sections + account branding for a valid token", async () => {
    const doc = await createDocDraft(accountA, "Public Shared", "Purpose here");
    const share = await createShareToken(accountA, doc.id);

    const result = await getSharedDocumentByToken(share.token);
    expect(result.doc.id).toBe(doc.id);
    expect(result.doc.title).toBe("Public Shared");
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].content).toBe("Purpose here");
    expect(result.namespaceSlug).toBeTruthy();
    expect(result.memexName).toBeTruthy();
  });

  it("throws ShareTokenError with reason='unknown' for a nonexistent token", async () => {
    await expect(getSharedDocumentByToken("not-a-real-token"))
      .rejects.toMatchObject({ name: "ShareTokenError", reason: "unknown" });
  });

  it("throws ShareTokenError with reason='revoked' for a revoked token", async () => {
    const doc = await createDocDraft(accountA, "Will Revoke", "Purpose");
    const share = await createShareToken(accountA, doc.id);
    await revokeShareToken(accountA, share.id);

    await expect(getSharedDocumentByToken(share.token))
      .rejects.toMatchObject({ name: "ShareTokenError", reason: "revoked" });
  });

  it("scoping: a token for doc A does not leak any other account's data", async () => {
    const docA = await createDocDraft(accountA, "Account A Doc", "A purpose");
    const docB = await createDocDraft(accountB, "Account B Doc", "B purpose");
    const shareA = await createShareToken(accountA, docA.id);

    // Public access with A's token returns A's doc
    const result = await getSharedDocumentByToken(shareA.token);
    expect(result.doc.id).toBe(docA.id);
    expect(result.doc.title).toBe("Account A Doc");
    // Sanity: it's NOT B's doc
    expect(result.doc.id).not.toBe(docB.id);
  });
});
