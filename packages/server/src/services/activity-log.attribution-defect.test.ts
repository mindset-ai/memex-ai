// spec-122 t-3 (dec-5 / ac-21) — a mutation reaching the activity sink without a
// channel is surfaced as a VISIBLE defect (a loud structured log + a process
// counter), not silently masked by the 'server' default. Reads are exempt.
//
// TAGGED → reports to the PROD memex. Run with MEMEX_EMIT_KEY set.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  flagAttributionDefect,
  getUnattributedMutationCount,
  _resetUnattributedMutationCount,
} from "./activity-log.js";
import type { ChangeEvent } from "./bus.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-122/acs";

function event(partial: Partial<ChangeEvent>): ChangeEvent {
  return { memexId: "m1", entity: "task", action: "created", ...partial };
}

describe("activity-log attribution defect [spec-122 t-3]", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    _resetUnattributedMutationCount();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  // ── ac-21 ───────────────────────────────────────────────────────────────
  it("ac-21: a channel-less mutation is surfaced — counter increments + a loud defect log", () => {
    tagAc(`${AC}/ac-21`);
    const defect = flagAttributionDefect(event({ action: "updated", channel: undefined }));
    expect(defect).toBe(true);
    expect(getUnattributedMutationCount()).toBe(1);
    const logged = errSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("ATTRIBUTION DEFECT");
  });

  it("ac-21: a mutation WITH a channel is NOT flagged (no silent default needed)", () => {
    tagAc(`${AC}/ac-21`);
    const defect = flagAttributionDefect(event({ action: "created", channel: "mcp" }));
    expect(defect).toBe(false);
    expect(getUnattributedMutationCount()).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("ac-21: a READ action with no channel is exempt (reads aren't attribution-bearing)", () => {
    tagAc(`${AC}/ac-21`);
    expect(flagAttributionDefect(event({ action: "viewed", channel: undefined }))).toBe(false);
    expect(flagAttributionDefect(event({ action: "searched", channel: undefined }))).toBe(false);
    expect(getUnattributedMutationCount()).toBe(0);
  });

  it("ac-21: status_changed (a phase move) without a channel is also a visible defect", () => {
    tagAc(`${AC}/ac-21`);
    expect(
      flagAttributionDefect(event({ entity: "document", action: "status_changed", channel: undefined })),
    ).toBe(true);
    expect(getUnattributedMutationCount()).toBe(1);
  });
});
