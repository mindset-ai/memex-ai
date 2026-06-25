import { describe, it, expect } from "vitest";
import { isUuid, parseHandle, containsUuid, stripUuids } from "./identifiers.js";

describe("isUuid", () => {
  it("returns true for a valid lowercase UUID", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("returns true for an uppercase UUID", () => {
    expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("returns true for a mixed-case UUID", () => {
    expect(isUuid("550e8400-E29B-41d4-a716-446655440000")).toBe(true);
  });

  it("returns false for missing hyphens", () => {
    expect(isUuid("550e8400e29b41d4a716446655440000")).toBe(false);
  });

  it("returns false for wrong segment lengths", () => {
    expect(isUuid("550e840-0e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("returns false for non-hex characters", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-44665544000g")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUuid("")).toBe(false);
  });

  it("returns false for a handle like dec-1", () => {
    expect(isUuid("dec-1")).toBe(false);
  });
});

describe("parseHandle", () => {
  it("parses dec-N format", () => {
    expect(parseHandle("dec-1", "dec-")).toBe(1);
    expect(parseHandle("dec-99", "dec-")).toBe(99);
  });

  it("parses t-N format", () => {
    expect(parseHandle("t-1", "t-")).toBe(1);
    expect(parseHandle("t-42", "t-")).toBe(42);
  });

  it("is case-insensitive", () => {
    expect(parseHandle("DEC-5", "dec-")).toBe(5);
    expect(parseHandle("T-3", "t-")).toBe(3);
  });

  it("returns null for wrong prefix", () => {
    expect(parseHandle("t-1", "dec-")).toBeNull();
    expect(parseHandle("dec-1", "t-")).toBeNull();
  });

  it("returns null for non-numeric suffix", () => {
    expect(parseHandle("dec-abc", "dec-")).toBeNull();
    expect(parseHandle("t-", "t-")).toBeNull();
  });

  it("returns null for prefix alone", () => {
    expect(parseHandle("dec", "dec-")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseHandle("", "dec-")).toBeNull();
  });

  it("returns null for UUID (not a handle)", () => {
    expect(parseHandle("550e8400-e29b-41d4-a716-446655440000", "dec-")).toBeNull();
  });
});

describe("containsUuid", () => {
  it("detects a UUID embedded in free text", () => {
    expect(containsUuid("created doc_member 322dda5d-b14c-4597-b106-c13b847905ac")).toBe(true);
  });
  it("is false for handle-bearing narratives", () => {
    expect(containsUuid("promoted Barrie to editor on spec-7")).toBe(false);
  });
  it("is false for empty / plain strings", () => {
    expect(containsUuid("")).toBe(false);
    expect(containsUuid("System")).toBe(false);
  });
  it("is stateless across calls (no global-regex lastIndex bug)", () => {
    const s = "x 322dda5d-b14c-4597-b106-c13b847905ac";
    expect(containsUuid(s)).toBe(true);
    expect(containsUuid(s)).toBe(true); // would flip false on the 2nd call if /g were reused
  });
});

describe("stripUuids", () => {
  it("removes a UUID token and tidies the dangling separator/spaces", () => {
    expect(stripUuids("created doc_member 322dda5d-b14c-4597-b106-c13b847905ac")).toBe(
      "created doc_member",
    );
  });
  it("removes a trailing ' — <uuid>' actor tail", () => {
    expect(
      stripUuids("recent: created document spec-3 — 322dda5d-b14c-4597-b106-c13b847905ac 2m ago"),
    ).toBe("recent: created document spec-3 — 2m ago");
  });
  it("preserves newlines (only space runs collapse)", () => {
    const out = stripUuids("line one 550e8400-e29b-41d4-a716-446655440000\nline two");
    expect(out).toBe("line one\nline two");
  });
  it("leaves UUID-free text untouched", () => {
    expect(stripUuids("promoted Barrie to editor on spec-7")).toBe(
      "promoted Barrie to editor on spec-7",
    );
  });
});
