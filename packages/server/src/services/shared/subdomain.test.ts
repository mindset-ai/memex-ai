import { describe, it, expect } from "vitest";
import { validateSubdomainFormat, RESERVED_SUBDOMAINS } from "./subdomain.js";

describe("validateSubdomainFormat", () => {
  it("accepts valid subdomains", () => {
    expect(validateSubdomainFormat("acme")).toEqual({ valid: true });
    expect(validateSubdomainFormat("acme-co")).toEqual({ valid: true });
    expect(validateSubdomainFormat("a1b")).toEqual({ valid: true });
    expect(validateSubdomainFormat("123abc")).toEqual({ valid: true });
    expect(validateSubdomainFormat("a".repeat(63))).toEqual({ valid: true });
  });

  it("rejects too-short subdomains", () => {
    expect(validateSubdomainFormat("ab")).toEqual({ valid: false, error: "too_short" });
    expect(validateSubdomainFormat("")).toEqual({ valid: false, error: "too_short" });
  });

  it("rejects too-long subdomains", () => {
    expect(validateSubdomainFormat("a".repeat(64))).toEqual({ valid: false, error: "too_long" });
  });

  it("rejects invalid characters", () => {
    expect(validateSubdomainFormat("acme_co")).toEqual({ valid: false, error: "invalid_chars" });
    expect(validateSubdomainFormat("acme.co")).toEqual({ valid: false, error: "invalid_chars" });
    expect(validateSubdomainFormat("acme co")).toEqual({ valid: false, error: "invalid_chars" });
    expect(validateSubdomainFormat("acme!")).toEqual({ valid: false, error: "invalid_chars" });
  });

  it("rejects leading/trailing hyphens", () => {
    expect(validateSubdomainFormat("-acme")).toEqual({ valid: false, error: "invalid_chars" });
    expect(validateSubdomainFormat("acme-")).toEqual({ valid: false, error: "invalid_chars" });
  });

  it("rejects reserved subdomains", () => {
    for (const reserved of RESERVED_SUBDOMAINS) {
      expect(validateSubdomainFormat(reserved)).toEqual({ valid: false, error: "reserved" });
    }
  });

  it("normalizes input casing and whitespace before validating", () => {
    expect(validateSubdomainFormat("  ACME  ")).toEqual({ valid: true });
    expect(validateSubdomainFormat("WWW")).toEqual({ valid: false, error: "reserved" });
  });
});
