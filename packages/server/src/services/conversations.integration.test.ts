import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, conversations, messages } from "../db/schema.js";
import { createDocDraft } from "./documents.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  getOrCreateConversation,
  getMessages,
  appendMessage,
  clearConversation,
} from "./conversations.js";

const createdDocIds: string[] = [];
const createdConvIds: string[] = [];

afterAll(async () => {
  for (const id of createdConvIds) {
    await db.delete(messages).where(eq(messages.conversationId, id)).catch(() => {});
    await db.delete(conversations).where(eq(conversations.id, id)).catch(() => {});
  }
  for (const id of createdDocIds) {
    await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
  }
});


let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex();
});

describe("getOrCreateConversation", () => {
  let docId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Conv Test Doc", "Purpose");
    docId = doc.id;
    createdDocIds.push(doc.id);
  });

  it("creates a new conversation when none exists", async () => {
    const conv = await getOrCreateConversation(memexId, docId, "user-1");
    createdConvIds.push(conv.id);

    expect(conv.docId).toBe(docId);
    expect(conv.userId).toBe("user-1");
    expect(conv.id).toBeTruthy();
  });

  it("returns existing conversation for same doc+user", async () => {
    const first = await getOrCreateConversation(memexId, docId, "user-2");
    createdConvIds.push(first.id);

    const second = await getOrCreateConversation(memexId, docId, "user-2");
    expect(second.id).toBe(first.id);
  });

  it("creates separate conversations for different users", async () => {
    const conv1 = await getOrCreateConversation(memexId, docId, "user-a");
    const conv2 = await getOrCreateConversation(memexId, docId, "user-b");
    createdConvIds.push(conv1.id, conv2.id);

    expect(conv1.id).not.toBe(conv2.id);
  });
});

describe("appendMessage / getMessages", () => {
  let convId: string;

  beforeAll(async () => {
    const doc = await createDocDraft(memexId, "Msg Test Doc", "Purpose");
    createdDocIds.push(doc.id);
    const conv = await getOrCreateConversation(memexId, doc.id, "user-1");
    convId = conv.id;
    createdConvIds.push(conv.id);
  });

  it("appends messages with sequential seq values", async () => {
    const msg1 = await appendMessage(convId, "member", "Hello");
    const msg2 = await appendMessage(convId, "assistant", "Hi there");

    expect(msg2.seq).toBe(msg1.seq + 1);
  });

  it("stores different content types", async () => {
    const textMsg = await appendMessage(convId, "member", "plain text");
    expect(textMsg.content).toBe("plain text");

    const objMsg = await appendMessage(convId, "assistant", [
      { type: "text", text: "response" },
    ]);
    expect(objMsg.content).toEqual([{ type: "text", text: "response" }]);
  });

  it("returns messages ordered by seq", async () => {
    const msgs = await getMessages(convId);
    expect(msgs.length).toBeGreaterThan(0);

    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].seq).toBeGreaterThan(msgs[i - 1].seq);
    }
  });
});

describe("clearConversation", () => {
  it("deletes all messages from a conversation", async () => {
    const doc = await createDocDraft(memexId, "Clear Test Doc", "Purpose");
    createdDocIds.push(doc.id);
    const conv = await getOrCreateConversation(memexId, doc.id, "user-1");
    createdConvIds.push(conv.id);

    await appendMessage(conv.id, "member", "Message 1");
    await appendMessage(conv.id, "assistant", "Message 2");

    await clearConversation(conv.id);

    const msgs = await getMessages(conv.id);
    expect(msgs).toHaveLength(0);
  });
});
