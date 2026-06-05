import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { buildSystemBlocks } from "./system-prompt.js";

// spec-111 t-9 — read-only agent prompt block.
//
// ac-13: the system prompt includes the read-only context ONLY when the
// per-request readOnly flag is set. Org members (readOnly omitted / false)
// get the unchanged prompt. The block text lives in the @memex/shared scaffold
// model (BASE_READ_ONLY — b-68 dec-6), not inline in code or a phases/*.md
// file — these assertions pin the exact sentence so a copy drift is caught.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-111/acs/ac-${n}`;

const READ_ONLY_SENTENCE =
  "You are in read-only mode. You can answer questions, explain decisions, and search content, but cannot create, update, or delete anything.";

describe("buildSystemBlocks — read-only mode (spec-111 t-9)", () => {
  it("includes the read-only block when readOnly=true", () => {
    tagAc(AC(13));
    const blocks = buildSystemBlocks("ctx", "plan", true);
    expect(blocks[0].text).toContain(READ_ONLY_SENTENCE);
  });

  it("omits the read-only block when readOnly=false", () => {
    tagAc(AC(13));
    const blocks = buildSystemBlocks("ctx", "plan", false);
    expect(blocks[0].text).not.toContain(READ_ONLY_SENTENCE);
  });

  it("omits the read-only block when readOnly is not passed (org-member default)", () => {
    tagAc(AC(13));
    const blocks = buildSystemBlocks("ctx", "plan");
    expect(blocks[0].text).not.toContain(READ_ONLY_SENTENCE);
  });

  it("injects the block across every phase when readOnly=true", () => {
    tagAc(AC(13));
    const phases = ["draft", "plan", "build", "verify", "done"] as const;
    for (const phase of phases) {
      const text = buildSystemBlocks("ctx", phase, true)[0].text;
      expect(text, `phase=${phase} missing read-only block`).toContain(
        READ_ONLY_SENTENCE,
      );
    }
  });

  it("keeps the read-only block in the instruction block, not the document-context block", () => {
    tagAc(AC(13));
    const blocks = buildSystemBlocks("DOC BODY", "plan", true);
    // block[1] is the cache-broken Document Context block; the read-only
    // guidance must ride the instruction block (block[0]) alongside the role.
    expect(blocks[0].text).toContain(READ_ONLY_SENTENCE);
    expect(blocks[1].text).not.toContain(READ_ONLY_SENTENCE);
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
  });
});
