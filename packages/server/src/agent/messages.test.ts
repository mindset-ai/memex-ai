import { describe, it, expect } from "vitest";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { stripDanglingToolUses } from "./messages.js";

describe("stripDanglingToolUses", () => {
  it("returns messages unchanged when no tool_use blocks are present", () => {
    const msgs: MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(stripDanglingToolUses(msgs)).toEqual(msgs);
  });

  it("preserves a tool_use that has a matching tool_result in the next message", () => {
    const msgs: MessageParam[] = [
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "render_confirmation",
            input: { message: "ok?" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "yes" },
        ],
      },
    ];
    expect(stripDanglingToolUses(msgs)).toEqual(msgs);
  });

  it("strips an orphaned tool_use when the next user message is plain text", () => {
    // This is the bug from the report: render_confirmation tool_use followed by
    // a fresh user prompt instead of a tool_result — Anthropic 400s without this fix.
    const msgs: MessageParam[] = [
      { role: "user", content: "create a spec" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's a draft. Confirm?" },
          {
            type: "tool_use",
            id: "toolu_01AEGrDhhgFBTcWkw4HHthY9",
            name: "render_confirmation",
            input: { message: "Looks good?" },
          },
        ],
      },
      { role: "user", content: "actually wait, change the title to X" },
    ];

    const result = stripDanglingToolUses(msgs);
    expect(result).toHaveLength(3);
    // Text preserved, tool_use stripped.
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Here's a draft. Confirm?" }],
    });
    // Trailing user message untouched.
    expect(result[2]).toEqual({
      role: "user",
      content: "actually wait, change the title to X",
    });
  });

  it("strips an orphaned tool_use at the very end of history (no next message)", () => {
    const msgs: MessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking…" },
          {
            type: "tool_use",
            id: "toolu_orphan",
            name: "render_confirmation",
            input: {},
          },
        ],
      },
    ];

    const result = stripDanglingToolUses(msgs);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "thinking…" }],
    });
  });

  it("strips all tool_use blocks in an assistant turn if any are orphaned", () => {
    // If a turn has two tool_use blocks but only one is answered, the round-trip
    // is still malformed. Strip all of them so the turn is consistent.
    const msgs: MessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "doing both" },
          { type: "tool_use", id: "t1", name: "render_confirmation", input: {} },
          { type: "tool_use", id: "t2", name: "render_choices", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          // t2 has no result — turn is half-answered.
        ],
      },
      { role: "user", content: "never mind" },
    ];

    const result = stripDanglingToolUses(msgs);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "doing both" }],
    });
  });

  it("replaces empty content with a placeholder text block when stripping leaves nothing", () => {
    // Assistant turn that's pure tool_use (no text) — if we strip every block we
    // can't leave the message with empty content (Anthropic rejects empty).
    const msgs: MessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "lonely", name: "render_confirmation", input: {} },
        ],
      },
      { role: "user", content: "skipping the button" },
    ];

    const result = stripDanglingToolUses(msgs);
    expect(result[1].role).toBe("assistant");
    expect(Array.isArray(result[1].content)).toBe(true);
    const blocks = result[1].content as Array<{ type: string }>;
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.type !== "tool_use")).toBe(true);
  });

  it("handles plain-string assistant content without throwing", () => {
    const msgs: MessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "just text, no blocks" },
    ];
    expect(stripDanglingToolUses(msgs)).toEqual(msgs);
  });

  it("returns an empty array unchanged", () => {
    expect(stripDanglingToolUses([])).toEqual([]);
  });
});
