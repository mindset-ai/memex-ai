import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, shareTokens, users } from "../db/schema.js";
import { tagAc } from "@memex-ai-ac/vitest";
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
import { upsertUserByEmail } from "./users.js";

let accountA: string;
let accountB: string;
const createdUserIds: string[] = [];

beforeAll(async () => {
  accountA = await makeTestMemex("sta");
  accountB = await makeTestMemex("stb");
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
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

const AC_199 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-199/acs/ac-${n}`;

describe("spec-199 t-3 — createdByUserId recorded on token creation (ac-9)", () => {
  it("createShareToken records the caller userId in createdByUserId", async () => {
    tagAc(AC_199(9));
    const user = await upsertUserByEmail(`created-by-${Date.now()}@st.test`);
    createdUserIds.push(user.id);
    const doc = await createDocDraft(accountA, "Created-by Test", "purpose");
    const token = await createShareToken(accountA, doc.id, user.id);
    const row = await db.query.shareTokens.findFirst({ where: eq(shareTokens.id, token.id) });
    expect(row?.createdByUserId).toBe(user.id);
  });

  it("createShareToken with no caller records null createdByUserId (backward compat)", async () => {
    tagAc(AC_199(9));
    const doc = await createDocDraft(accountA, "Anon Token", "purpose");
    const token = await createShareToken(accountA, doc.id);
    const row = await db.query.shareTokens.findFirst({ where: eq(shareTokens.id, token.id) });
    expect(row?.createdByUserId).toBeNull();
  });
});

describe("spec-199 t-3 — expires_at enforced on redemption (ac-12)", () => {
  it("getSharedDocumentByToken throws revoked on an expired token (ac-12)", async () => {
    tagAc(AC_199(12));
    const doc = await createDocDraft(accountA, "Expiry Test", "purpose");
    const share = await createShareToken(accountA, doc.id);
    const past = new Date(Date.now() - 1000);
    await db.update(shareTokens).set({ expiresAt: past }).where(eq(shareTokens.id, share.id));
    const err = await getSharedDocumentByToken(share.token).catch((e) => e as ShareTokenError);
    expect(err).toBeInstanceOf(ShareTokenError);
    expect(err.reason).toBe("revoked");
  });

  it("getSharedDocumentByToken succeeds for a token with a future expiresAt (ac-12)", async () => {
    tagAc(AC_199(12));
    const doc = await createDocDraft(accountA, "Future Expiry", "purpose");
    const share = await createShareToken(accountA, doc.id);
    const future = new Date(Date.now() + 86_400_000);
    await db.update(shareTokens).set({ expiresAt: future }).where(eq(shareTokens.id, share.id));
    const result = await getSharedDocumentByToken(share.token);
    expect(result.doc.id).toBe(doc.id);
  });
});
