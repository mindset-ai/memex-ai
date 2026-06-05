// Test-only HTTP endpoints — mounted ONLY when MEMEX_ANTHROPIC_FAKE=1 is set. Lets an
// out-of-process test runner (Playwright) drive the Anthropic fake queue over HTTP.
//
// Never mount this in production. The env-flag check in app.ts is the only gate.

import { Hono } from "hono";
import { z } from "zod/v4";
import {
  clearFakeQueue,
  enqueueFakeResponse,
  peekFakeQueueLength,
  type QueuedFakeResponse,
} from "../agent/anthropic-fake.js";

const contentBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
]);

const queueSchema = z.object({
  textDeltas: z.array(z.string()),
  content: z.array(contentBlockSchema),
  stopReason: z.enum(["end_turn", "tool_use", "max_tokens", "stop_sequence"]),
  deltaDelayMs: z.number().int().nonnegative().optional(),
});

export const testOnlyRouter = new Hono();

testOnlyRouter.post("/anthropic-queue", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = queueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request", details: parsed.error.issues },
      400
    );
  }
  enqueueFakeResponse(parsed.data as QueuedFakeResponse);
  return c.json({ ok: true, queueLength: peekFakeQueueLength() });
});

testOnlyRouter.delete("/anthropic-queue", (c) => {
  clearFakeQueue();
  return c.json({ ok: true });
});

testOnlyRouter.get("/anthropic-queue", (c) =>
  c.json({ queueLength: peekFakeQueueLength() })
);
