import { describe, it, expect } from "vitest";
import { isFreeEmailDomain } from "./free-email-domains.js";

// t-14: edge cases deferred from t-6. The free-domain list is an exact-match set — subdomains
// of free providers (e.g., something.gmail.com) are NOT free providers, and some common
// gotchas (case handling, trailing dots, IDN-ish inputs).

describe("isFreeEmailDomain edge cases (t-14)", () => {
  it("rejects subdomains of free providers (exact-match only)", () => {
    // student.gmail.com is a (hypothetical) subdomain, not the root gmail.com
    expect(isFreeEmailDomain("student.gmail.com")).toBe(false);
    expect(isFreeEmailDomain("mail.outlook.com")).toBe(false);
  });

  it("handles leading/trailing whitespace", () => {
    expect(isFreeEmailDomain("  gmail.com  ")).toBe(true);
    expect(isFreeEmailDomain("\tyahoo.com\n")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isFreeEmailDomain("Gmail.Com")).toBe(true);
    expect(isFreeEmailDomain("YAHOO.COM")).toBe(true);
  });

  it("accepts the full-email form (strips local part)", () => {
    expect(isFreeEmailDomain("user+tag@gmail.com")).toBe(true);
    expect(isFreeEmailDomain("Alice.Smith@YAHOO.com")).toBe(true);
  });

  it("treats empty and malformed inputs as not-free", () => {
    expect(isFreeEmailDomain("")).toBe(false);
    expect(isFreeEmailDomain("no-at-sign")).toBe(false);
    expect(isFreeEmailDomain("multiple@@gmail.com")).toBe(false);
  });

  it("does not match if the domain is a strict substring match of a free domain", () => {
    // "gmail.co" is not the same as "gmail.com" — must be exact.
    expect(isFreeEmailDomain("gmail.co")).toBe(false);
    expect(isFreeEmailDomain("yahoo.net")).toBe(false);
  });

  it("corporate domains stay corporate even when they look similar to free providers", () => {
    expect(isFreeEmailDomain("acme.com")).toBe(false);
    expect(isFreeEmailDomain("gmailonline.net")).toBe(false);
    expect(isFreeEmailDomain("not-outlook-really.com")).toBe(false);
  });
});
