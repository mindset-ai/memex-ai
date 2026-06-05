// Integration coverage for t-21 Issue 7 — agent knowledge of standards.
//
// We don't drive the real LLM here (that's a non-deterministic surface). What we
// verify is the full plumbing the agent needs to give a useful answer:
//   1. The system prompt sent into the chat handler contains the dec-3 working
//      definition of a standard (rules + drift + provenance).
//   2. The chat handler's tool definitions include list_standards / get_standard
//      so the agent can ground its answer in real data when asked.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createMiddleware } from "hono/factory";

// Capture every call into the Anthropic stream so we can inspect what tools and
// system prompt the route actually shipped.
const captured = vi.hoisted(() => ({
  lastSystem: null as null | unknown,
  lastTools: null as null | Array<{ name: string }>,
}));

const fakeState = vi.hoisted(() => ({
  nextResponse: null as null | {
    content: Array<{ type: "text"; text: string }>;
    stopReason: "end_turn";
    textDeltas?: string[];
  },
}));

vi.mock("../agent/anthropic-client.js", () => ({
  getAnthropicClient: () => ({
    messages: {
      stream: (params: { system?: unknown; tools?: Array<{ name: string }> }) => {
        captured.lastSystem = params.system ?? null;
        captured.lastTools = params.tools ?? null;
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

import { llmRouter } from "./llm.js";

function makeApp(memexId: string) {
  const app = new Hono();
  app.use(
    "*",
    createMiddleware(async (c, next) => {
      c.set("user" as never, {
        id: "00000000-0000-0000-0000-0000000000ac",
        email: "standard-knowledge-test@memex.ai",
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
const created: string[] = [];

beforeAll(async () => {
  memexId = await makeTestMemex("standard-know");
  created.push(memexId);
  const doc = await createDocDraft(memexId, "Knowledge Test Doc", "Why this exists");
  docId = doc.id;
});

afterAll(async () => {
  for (const id of created) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
});

function systemAsString(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join("\n");
  }
  return "";
}

// SKIP: doc-24 — Standard / Document doc types no longer exposed via MCP/agent; restore alongside the tools.
describe.skip("t-21 Issue 7 — agent knowledge of standards flows through chat handler", () => {
  it("system prompt sent to the LLM contains the dec-3 standard definition", async () => {
    const app = makeApp(memexId);
    fakeState.nextResponse = {
      textDeltas: ["A standard is a living rule document the agent maintains."],
      content: [
        { type: "text", text: "A standard is a living rule document the agent maintains." },
      ],
      stopReason: "end_turn",
    };

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "what is a standard?" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const sys = systemAsString(captured.lastSystem);
    // dec-3 working definition: rules + drift + provenance
    expect(sys).toMatch(/\bStandard\b/);
    expect(sys).toMatch(/rules?, conventions/i);
    expect(sys).toMatch(/drift/i);
    expect(sys).toMatch(/per doc-N:dec-M/);
  });

  it("standard server tools are registered in the chat tool surface (post doc-14)", async () => {
    // doc-14: list_standards / get_standard / create_standard folded into list_docs / get_doc / create_doc
    // with docType: 'standard'. The named verbs `flag_drift`, `propose_standard_change`, and
    // `search_standards` survive — those carry distinct prompt-engineering value.
    const tools = captured.lastTools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_docs");
    expect(names).toContain("get_doc");
    expect(names).toContain("create_doc");
    expect(names).toContain("flag_drift");
    expect(names).toContain("propose_standard_change");
    expect(names).toContain("search_standards");
  });

  it("Document and Spec definitions are also in the system prompt (dec-3)", async () => {
    const sys = systemAsString(captured.lastSystem);
    expect(sys).toMatch(/\bSpec\b.*specification|\bSpec\b.*the why/i);
    expect(sys).toMatch(/\bDocument\b.*?(specs|ADRs|runbooks)/i);
  });
});
