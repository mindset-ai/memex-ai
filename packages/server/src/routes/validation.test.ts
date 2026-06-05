import { describe, it, expect } from "vitest";
import { requireString, requireUuid, requireEmail, readJsonBody } from "./validation.js";
import { ValidationError } from "../types/errors.js";

describe("requireString", () => {
  it("returns the value when it's a non-empty string", () => {
    expect(requireString("hello", "field")).toBe("hello");
  });

  it("throws ValidationError on undefined / null / non-string", () => {
    expect(() => requireString(undefined, "email")).toThrow(ValidationError);
    expect(() => requireString(null, "email")).toThrow(ValidationError);
    expect(() => requireString(123, "email")).toThrow(ValidationError);
    expect(() => requireString({}, "email")).toThrow(ValidationError);
  });

  it("throws on empty string with a field-name-aware message", () => {
    try {
      requireString("", "subdomain");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe("subdomain is required");
    }
  });

  it("does NOT trim by default — preserves whitespace (e.g. passwords)", () => {
    expect(requireString("  pw  ", "password")).toBe("  pw  ");
  });

  it("trims and rejects whitespace-only when { trim: true }", () => {
    expect(requireString("  hello  ", "name", { trim: true })).toBe("hello");
    expect(() => requireString("   ", "name", { trim: true })).toThrow(ValidationError);
  });

  it("enforces maxLength after trim", () => {
    expect(() =>
      requireString("a".repeat(101), "name", { trim: true, maxLength: 100 }),
    ).toThrow(/100 characters/);
    expect(requireString("a".repeat(100), "name", { trim: true, maxLength: 100 })).toHaveLength(
      100,
    );
  });
});

describe("requireUuid", () => {
  const VALID = "a0b1c2d3-e4f5-6789-abcd-ef0123456789";

  it("accepts a valid v4-shaped UUID (case-insensitive)", () => {
    expect(requireUuid(VALID, "id")).toBe(VALID);
    expect(requireUuid(VALID.toUpperCase(), "id")).toBe(VALID.toUpperCase());
  });

  it("rejects non-UUID strings", () => {
    expect(() => requireUuid("not-a-uuid", "id")).toThrow(/UUID/);
    expect(() => requireUuid("12345", "id")).toThrow(/UUID/);
  });

  it("delegates required-string check to requireString", () => {
    expect(() => requireUuid(undefined, "id")).toThrow(/required/);
  });
});

describe("requireEmail", () => {
  it("accepts a valid email and lowercases it", () => {
    expect(requireEmail("Alice@Example.COM")).toBe("alice@example.com");
  });

  it("rejects malformed addresses", () => {
    expect(() => requireEmail("no-at-sign")).toThrow(/email/);
    expect(() => requireEmail("a@b")).toThrow(/email/);
    expect(() => requireEmail("a @b.c")).toThrow(/email/);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(requireEmail("  alice@example.com  ")).toBe("alice@example.com");
  });
});

describe("readJsonBody", () => {
  it("returns parsed JSON when valid", async () => {
    const c = { req: { json: async () => ({ a: 1 }) } };
    expect(await readJsonBody(c)).toEqual({ a: 1 });
  });

  it("throws ValidationError when JSON parsing fails", async () => {
    const c = {
      req: {
        json: async () => {
          throw new SyntaxError("bad");
        },
      },
    };
    await expect(readJsonBody(c)).rejects.toThrow(ValidationError);
  });
});
