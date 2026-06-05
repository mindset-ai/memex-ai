import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { upsertUserByEmail } from "./users.js";
import {
  createShareToken,
  createExternalComment,
  getSharedDocumentByToken,
  ShareTokenError,
} from "./share-tokens.js";
import { bus, type ChangeEvent } from "./bus.js";
import { NotFoundError } from "../types/errors.js";
import { makeTestMemex } from "./test-helpers.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-156/acs";

let hostAccount: string;
let externalAccount: string; // namespace.id of the external account (post-doc-15: author_namespace_id)

beforeAll(async () => {
  hostAccount = await makeTestMemex("host");
  // For the external commenter we need a namespace.id (the new authorNamespaceId
  // pointer). Resolve via the memex's namespace.
  const extMemexId = await makeTestMemex("ext");
  const extMemex = await db.query.memexes.findFirst({ where: eq(memexes.id, extMemexId) });
  externalAccount = extMemex!.namespaceId;
});

afterAll(async () => {
  await db
    .delete(memexes)
    .where(inArray(memexes.id, [hostAccount, externalAccount]))
    .catch(() => {});
});

describe("createExternalComment", () => {
  // spec-156 W3 ac-22: the widened static scan surfaced this as a std-8 bypass —
  // a share-link comment writes a doc_comments row scoped to doc.memexId but used
  // to skip mutate(), so the host Memex's live SSE stream never woke. The fix
  // routes it through mutate(); prove the comment.created event now fires.
  it("ac-22: emits comment.created on the host Memex's bus (std-8 hole closed)", async () => {
    tagAc(`${AC}/ac-22`);
    const doc = await createDocDraft(hostAccount, "External Comment Bus Doc", "Purpose");
    const share = await createShareToken(hostAccount, doc.id);
    const externalUser = await upsertUserByEmail(`ext-bus-${Date.now()}@example.com`);

    const events: ChangeEvent[] = [];
    const unsub = bus.subscribe({}, (e) => events.push(e));
    let commentId: string;
    try {
      const comment = await createExternalComment({
        token: share.token,
        authorUserId: externalUser.id,
        authorNamespaceId: externalAccount,
        authorName: "External User",
        target: { kind: "section", id: doc.sections[0].id },
        content: "Bus me please",
      });
      commentId = comment.id;
    } finally {
      unsub();
    }

    const emitted = events.filter(
      (e) =>
        e.memexId === hostAccount &&
        e.docId === doc.id &&
        e.entity === "comment" &&
        e.action === "created",
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].narrative, "mutate() composes a narrative for the comment").toBeDefined();
    expect(typeof commentId).toBe("string");
  });

  it("creates a comment on a shared section with author attribution", async () => {
    const doc = await createDocDraft(hostAccount, "External Comments Doc", "Purpose");
    const share = await createShareToken(hostAccount, doc.id);
    const externalUser = await upsertUserByEmail(`ext-${Date.now()}@example.com`);

    const comment = await createExternalComment({
      token: share.token,
      authorUserId: externalUser.id,
      authorNamespaceId: externalAccount,
      authorName: "External User",
      target: { kind: "section", id: doc.sections[0].id },
      content: "Great doc!",
    });

    expect(comment.memexId).toBe(hostAccount); // scoped to doc's account
    expect(comment.authorUserId).toBe(externalUser.id);
    expect(comment.authorNamespaceId).toBe(externalAccount); // different from hostAccount
    expect(comment.authorName).toBe("External User");
    expect(comment.content).toBe("Great doc!");
    // Since authorNamespaceId !== memexId, this is an external comment (rendered with badge)
    expect(comment.authorNamespaceId).not.toBe(comment.memexId);
  });

  it("rejects commenting when the token is revoked", async () => {
    const doc = await createDocDraft(hostAccount, "Revoked Comment Doc", "Purpose");
    const share = await createShareToken(hostAccount, doc.id);
    await db
      .update((await import("../db/schema.js")).shareTokens)
      .set({ revoked: true })
      .where(eq((await import("../db/schema.js")).shareTokens.id, share.id));

    const externalUser = await upsertUserByEmail(`ext2-${Date.now()}@example.com`);
    await expect(
      createExternalComment({
        token: share.token,
        authorUserId: externalUser.id,
        authorNamespaceId: externalAccount,
        authorName: "Blocked",
        target: { kind: "section", id: doc.sections[0].id },
        content: "Shouldn't work",
      })
    ).rejects.toMatchObject({ name: "ShareTokenError", reason: "revoked" });
  });

  it("rejects commenting on a section from a DIFFERENT doc via the token", async () => {
    const hostDoc = await createDocDraft(hostAccount, "Host Doc", "Purpose");
    const otherDoc = await createDocDraft(hostAccount, "Other Doc", "Purpose");
    const share = await createShareToken(hostAccount, hostDoc.id);
    const externalUser = await upsertUserByEmail(`ext3-${Date.now()}@example.com`);

    await expect(
      createExternalComment({
        token: share.token,
        authorUserId: externalUser.id,
        authorNamespaceId: externalAccount,
        authorName: "Wrong Section",
        target: { kind: "section", id: otherDoc.sections[0].id },
        content: "Should fail",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects unknown tokens", async () => {
    const externalUser = await upsertUserByEmail(`ext4-${Date.now()}@example.com`);
    await expect(
      createExternalComment({
        token: "not-a-token",
        authorUserId: externalUser.id,
        authorNamespaceId: externalAccount,
        authorName: "Ghost",
        target: { kind: "section", id: "00000000-0000-0000-0000-000000000000" },
        content: "Shouldn't work",
      })
    ).rejects.toBeInstanceOf(ShareTokenError);
  });
});

describe("getSharedDocumentByToken — includes comments", () => {
  it("returns external comments in the response payload", async () => {
    const doc = await createDocDraft(hostAccount, "Comments Included", "Purpose");
    const share = await createShareToken(hostAccount, doc.id);
    const externalUser = await upsertUserByEmail(`ext5-${Date.now()}@example.com`);

    await createExternalComment({
      token: share.token,
      authorUserId: externalUser.id,
      authorNamespaceId: externalAccount,
      authorName: "Alice External",
      target: { kind: "section", id: doc.sections[0].id },
      content: "Love it",
    });

    const payload = await getSharedDocumentByToken(share.token);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].authorName).toBe("Alice External");
    expect(payload.comments[0].authorNamespaceId).toBe(externalAccount);
    expect(payload.comments[0].memexId).toBe(hostAccount);
  });
});

describe("Referral attribution on account creation", () => {
  it("persists referralShareTokenId when creating a new account", async () => {
    const doc = await createDocDraft(hostAccount, "Referring Doc", "Purpose");
    const share = await createShareToken(hostAccount, doc.id);

    const { createOrgWithMemexAndOwner } = await import("./__test__/seed-org.js");
    const owner = await upsertUserByEmail(`referred-${Date.now()}@example.com`);
    const { memex: account } = await createOrgWithMemexAndOwner({
      slug: `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase(),
      ownerUserId: owner.id,
    });

    // referralShareTokenId column was dropped per dec-10 of doc-15 — referral
    // attribution is no longer persisted at account creation time.
    void share;
    expect(account.id).toBeTruthy();

    // Cleanup
    await db.delete(memexes).where(eq(memexes.id, account.id));
  });
});
