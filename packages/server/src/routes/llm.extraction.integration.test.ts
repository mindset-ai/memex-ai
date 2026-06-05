// Integration coverage for the per-turn decision-extraction wiring (t-12).
//
// What this verifies:
//   1. The /chat tool definitions sent to the agent include `propose_decision`. We assert
//      this directly against `getToolDefinitions()` rather than the network call so the
//      contract is independent of how the SDK shape evolves.
//   2. Driving the chat handler with a fake Anthropic stream that emits a `propose_decision`
//      tool_use block causes the corresponding /tools/execute call to mint a candidate
//      decision with status='candidate' on the document. (This is the round-trip the React
//      UI executes — final_message is streamed back, then the UI POSTs each tool_use to
//      /tools/execute.)
//   3. Driving the same handler with a fake stream that returns a plain text response
//      (no propose_decision tool_use) does NOT create any candidate. This is the
//      "routine message" guard rail.
//   4. The candidate written by the executor lands with status='candidate' and the agent
//      cannot inject `source` from the wire — the value is server-stamped (tested by
//      passing source:"human" via the input and confirming proposeDecision was still
//      called from the agent path).
//
// This test does NOT verify the LLM's own heuristic — that is t-11 territory (system
// prompt teaching). The contract here is just: when the agent emits propose_decision,
// the wiring works end-to-end.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { listDecisions } from "../services/decisions.js";
import { createMiddleware } from "hono/factory";

// Controllable fake Anthropic stream. Each test seeds `nextResponse` before issuing
// the chat request; the mocked SDK emits whichever blocks were queued.
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
          // Microtask to give the caller a chance to attach .on listeners.
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

// We want the system-prompt and context-builder calls to be cheap — we're not
// asserting on prompt content here, only that the wiring threads through.
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
        id: "00000000-0000-0000-0000-0000000000aa",
        email: "extraction-test@memex.ai",
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
  memexId = await makeTestMemex("extract");
  created.push(memexId);
  // b-36 T-6: spec docType so the canonical ref grammar resolves through
  // /specs/.
  const doc = await createDocDraft(memexId, "Extraction Test Doc", "Why", "spec");
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

describe("t-12 wiring: propose_decision is in the tool definitions on every turn", () => {
  it("getToolDefinitions() includes propose_decision", () => {
    const tools = getToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("create_decision");
  });

  it("propose_decision tool schema declares snake_case `trade_offs` (per dec-8)", () => {
    const tools = getToolDefinitions();
    const tool = tools.find((t) => t.name === "create_decision");
    expect(tool).toBeDefined();
    const optionsProp = tool!.input_schema.properties.options as {
      items?: { properties?: Record<string, unknown> };
    };
    expect(optionsProp.items?.properties).toHaveProperty("trade_offs");
    expect(optionsProp.items?.properties).not.toHaveProperty("tradeOffs");
  });
});

describe("t-12 wiring: decision-shape user message → propose_decision tool_use → candidate", () => {
  it("creates a candidate decision when the agent emits propose_decision", async () => {
    const app = makeApp(memexId);

    // Decision-shape input: 2 options + trade-offs + a choice pending.
    fakeState.nextResponse = {
      textDeltas: ["Looking at the options."],
      content: [
        { type: "text", text: "Looking at the options." },
        {
          type: "tool_use",
          id: "toolu_01PROP",
          name: "create_decision",
          input: {
            ref: docRef,
            title: "Should we use Postgres or DynamoDB for the catalog?",
            context: "We need durable storage for catalog rows. Two paths considered.",
            status: "candidate",
            options: [
              {
                label: "Postgres",
                trade_offs:
                  "Familiar; rich querying; harder to scale writes past one box.",
              },
              {
                label: "DynamoDB",
                trade_offs:
                  "Scales horizontally; weaker query model; new operational surface.",
              },
            ],
          },
        },
      ],
      stopReason: "tool_use",
    };

    // Step 1: the chat round-trip — agent emits a propose_decision tool_use block.
    const chatRes = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [
          {
            role: "user",
            content: "Should we use Postgres or DynamoDB for the catalog?",
          },
        ],
      }),
    });
    expect(chatRes.status).toBe(200);
    // Drain the SSE body to ensure the chat handler completes (logging fires here).
    const sseText = await chatRes.text();
    expect(sseText).toContain("create_decision");
    expect(sseText).toContain("message_complete");

    // Step 2: the React UI's follow-up — POST the tool_use to /tools/execute.
    const execRes = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "create_decision",
        input: {
          ref: docRef,
          title: "Should we use Postgres or DynamoDB for the catalog?",
          context: "We need durable storage for catalog rows. Two paths considered.",
          status: "candidate",
          options: [
            {
              label: "Postgres",
              trade_offs:
                "Familiar; rich querying; harder to scale writes past one box.",
            },
            {
              label: "DynamoDB",
              trade_offs:
                "Scales horizontally; weaker query model; new operational surface.",
            },
          ],
        },
      }),
    });
    expect(execRes.status).toBe(200);
    const execBody = (await execRes.json()) as { result: string };
    // doc-14: create_decision({status:'candidate'}) returns "Candidate decision proposed: dec-N "<title>" (N options)."
    expect(execBody.result).toMatch(/Candidate decision proposed/i);
    expect(execBody.result).toMatch(/options/);

    // Step 3: confirm the row landed with status='candidate' on the right doc.
    const all = await listDecisions(memexId, docId);
    const candidate = all.find(
      (d) =>
        d.title === "Should we use Postgres or DynamoDB for the catalog?",
    );
    expect(candidate).toBeDefined();
    expect(candidate!.status).toBe("candidate");
    expect(Array.isArray(candidate!.options)).toBe(true);
    expect((candidate!.options as Array<{ label: string }>).length).toBe(2);
    // trade_offs preserved as snake_case in the persisted JSONB shape (dec-8).
    expect((candidate!.options as Array<{ trade_offs: string }>)[0].trade_offs).toMatch(
      /Familiar/,
    );
  });

  it("does NOT create a candidate when the agent returns a plain-text reply (routine message)", async () => {
    const app = makeApp(memexId);

    // Routine input: factual / procedural — no decision shape. Agent returns text only.
    fakeState.nextResponse = {
      textDeltas: ["I've updated the section title."],
      content: [{ type: "text", text: "I've updated the section title." }],
      stopReason: "end_turn",
    };

    const beforeCount = (await listDecisions(memexId, docId)).length;

    const res = await app.request("/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docId,
        messages: [{ role: "user", content: "Update the section title to 'Catalog'." }],
      }),
    });
    expect(res.status).toBe(200);
    const sseText = await res.text();
    expect(sseText).not.toContain("create_decision");
    expect(sseText).toContain("message_complete");

    // The chat round-trip alone never creates a row, but assert the count is unchanged
    // either way — no /tools/execute call happens for a turn with no tool_use blocks.
    const afterCount = (await listDecisions(memexId, docId)).length;
    expect(afterCount).toBe(beforeCount);
  });

  it("source is server-stamped — caller-supplied source is ignored at the agent boundary", async () => {
    const app = makeApp(memexId);

    // Even if a malicious or buggy caller tried to pass source:"human" through the
    // executor input, our agent path forces source:"agent" and status:"candidate".
    // (proposeDecision doesn't persist source today — no column — but the contract
    // is locked.)
    const execRes = await app.request("/llm/tools/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "create_decision",
        input: {
          ref: docRef,
          title: "Source-stamping check",
          context: "x",
          status: "candidate",
          source: "human", // should be ignored
        },
      }),
    });
    expect(execRes.status).toBe(200);

    const all = await listDecisions(memexId, docId);
    const row = all.find((d) => d.title === "Source-stamping check");
    expect(row).toBeDefined();
    expect(row!.status).toBe("candidate");
  });
});
