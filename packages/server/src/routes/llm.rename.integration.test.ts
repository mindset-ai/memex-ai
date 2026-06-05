// Integration coverage for the update_doc_title agent tool (t-21 Issue 1).
//
// Verifies:
//   1. getToolDefinitions() includes update_doc_title.
//   2. Driving the chat handler with a fake Anthropic stream that emits an
//      update_doc_title tool_use block lets the React UI follow up with
//      /llm/tools/execute and the document's title is updated end-to-end.
//
// Post-merge note: the rename tool was consolidated to `update_doc_title` when
// doc-5's t-1 work landed via merge. The legacy `rename_doc` name no longer
// exists in the tool surface.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft, getDoc } from "../services/documents.js";
import { createMiddleware } from "hono/factory";

const fakeState = vi.hoisted(() => ({
  nextResponse: null as null | {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    >;
    stopReason: "end_turn" | "tool_use";
    textDeltas?: string[];
  },
}));

vi.mock("../agent/anthropic-client.js", () => ({
  getAnthropicClient: () => ({
    messages: {
      stream: () => {
        const r = fakeState.nextResponse;
        if (!r) {
          throw new Error("test forgot to seed fakeState.nextResponse");
        }
        const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
        const finalPromise = (async () => {
          await Promise.resolve();
          for (const delta of r.textDeltas ?? []) {
            for (const cb of listeners.text ?? []) cb(delta);
          }
          return { content: r.content, stop_reason: r.stopReason };
        })();
        return {
          on(event: string, cb: (...args: unknown[]) => void) {
            (listeners[event] ??= []).push(cb);
            return this;
          },
          finalMessage: () => finalPromise,
        };
      },
    },
  }),
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));

vi.mock("../agent/context-builder.js", () => ({
  buildDocumentContext: vi.fn().mockResolvedValue({ context: "test ctx", phase: "plan" }),
}));

vi.mock("../agent/system-prompt.js", () => ({
  buildSystemBlocks: vi.fn().mockReturnValue([{ type: "text", text: "s" }]),
  buildCreationSystemBlocks: vi.fn().mockReturnValue([{ type: "text", text: "s" }]),
}));

import { llmRouter } from "./llm.js";
import { getToolDefinitions } from "../agent/tools.js";

// spec-126 ac-15/ac-16: the in-app /tools/execute write gate now calls
// canWriteMemex. This round-trip test acts as an authorized writer (the gate
// itself is unit-tested in llm.test.ts), so grant write capability — otherwise
// the org-namespace test user (no membership) is correctly read-only.
vi.mock("../mcp/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcp/auth.js")>()),
  canWriteMemex: vi.fn().mockResolvedValue(true),
}));

function makeApp(memexId: string) {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      c.set("user" as never, {
        id: "00000000-0000-0000-0000-0000000000ab",
        email: "rename-test@memex.ai",
        status: "active",
      });
      c.set("currentAccount" as never, {
        id: memexId,
        name: "Test",
        slug: "test",
      });
      c.set("currentMemexId" as never, memexId);
      c.set("currentRole" as never, "administrator");
      await next();
    })
  );
  app.route("/llm", llmRouter);
  return app;
}

let memexId: string;
let docId: string;
let docRef: string;
const created: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex("rename");
  created.push(memexId);
  // b-36 T-6: pass docType='spec' so the canonical ref resolves through
  // /specs/.
  const doc = await createDocDraft(memexId, "Original Title", "Why this doc exists", "spec");
  docId = doc.id;
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, mx!.namespaceId),
  });
  docRef = `${ns!.slug}/${mx!.slug}/specs/${doc.handle}`;
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
});

describe("doc-14: update_doc({title}) tool registration (renamed from update_doc_title)", () => {
  it("getToolDefinitions() includes update_doc", () => {
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("update_doc");
    // doc-14: update_doc_title folded into update_doc({title}).
    expect(names).not.toContain("update_doc_title");
    expect(names).not.toContain("rename_doc");
  });

  it("update_doc tool requires ref (post-b-36 T-6: single canonical ref input)", () => {
    const tool = getToolDefinitions().find((t) => t.name === "update_doc");
    expect(tool).toBeDefined();
    expect(tool!.input_schema.required).toEqual(["ref"]);
    expect(tool!.input_schema.properties).toHaveProperty("ref");
    expect(tool!.input_schema.properties).toHaveProperty("title");
    expect(tool!.input_schema.properties).toHaveProperty("status");
  });
});

describe("doc-14: rename request → update_doc({title}) tool_use → title updated", () => {
  it("renames the document end-to-end through the chat → execute round-trip", async () => {
    const app = makeApp(memexId);

    const newTitle = "Renamed Spec: clearer scope";

    fakeState.nextResponse = {
      textDeltas: ["Renaming the document."],
      content: [
        { type: "text", text: "Renaming the document." },
        {
          type: "tool_use",
          id: "toolu_01RENAME",
          name: "update_doc",
          input: { ref: docRef, title: newTitle },
        },
      ],
      stopReason: "tool_use",
    };

    const chatRes = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "Please rename this document to something clearer." }],
      }),
    });
    expect(chatRes.status).toBe(200);
    const sseText = await chatRes.text();
    expect(sseText).toContain("update_doc");
    expect(sseText).toContain("message_complete");

    const execRes = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "update_doc",
        input: { ref: docRef, title: newTitle },
      }),
    });
    expect(execRes.status).toBe(200);
    const execBody = (await execRes.json()) as { result: string };
    expect(execBody.result).toMatch(/renamed|updated/i);

    const after = await getDoc(memexId, docId);
    expect(after.title).toBe(newTitle);
  });
});
