import { describe, it, expect } from "vitest";
import { isFreeEmailDomain, getFreeEmailDomains } from "./free-email-domains.js";

describe("isFreeEmailDomain", () => {
  it("returns true for known free domains", () => {
    expect(isFreeEmailDomain("gmail.com")).toBe(true);
    expect(isFreeEmailDomain("outlook.com")).toBe(true);
    expect(isFreeEmailDomain("yahoo.com")).toBe(true);
    expect(isFreeEmailDomain("icloud.com")).toBe(true);
    expect(isFreeEmailDomain("protonmail.com")).toBe(true);
  });

  it("accepts full email addresses", () => {
    expect(isFreeEmailDomain("alice@gmail.com")).toBe(true);
    expect(isFreeEmailDomain("Bob@Outlook.com")).toBe(true);
  });

  it("returns false for corporate domains", () => {
    expect(isFreeEmailDomain("acme.com")).toBe(false);
    expect(isFreeEmailDomain("alice@acme.com")).toBe(false);
    expect(isFreeEmailDomain("mindset.ai")).toBe(false);
    expect(isFreeEmailDomain("memex.ai")).toBe(false);
  });

  it("normalizes case", () => {
    expect(isFreeEmailDomain("GMAIL.COM")).toBe(true);
    expect(isFreeEmailDomain("Gmail.Com")).toBe(true);
  });

  it("returns false for malformed input", () => {
    expect(isFreeEmailDomain("")).toBe(false);
    expect(isFreeEmailDomain("@gmail.com")).toBe(true); // domain extracted = "gmail.com"
    expect(isFreeEmailDomain("alice@")).toBe(false);
    expect(isFreeEmailDomain("no-at-sign")).toBe(false);
  });
});

describe("getFreeEmailDomains", () => {
  it("returns the sorted list of free domains", () => {
    const list = getFreeEmailDomains();
    expect(list.length).toBeGreaterThan(20);
    expect(list).toContain("gmail.com");
    // Sorted alphabetically — first entry should be alphabetically first in the set
    const sorted = [...list].sort();
    expect(list).toEqual(sorted);
  });
});
