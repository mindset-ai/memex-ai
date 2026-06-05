import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  MIN_PASSWORD_LENGTH,
} from "./passwords.js";

describe("password hashing", () => {
  it("hashes + verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery stapie", hash)).toBe(false);
  });

  it("produces a different hash each time (random salt)", async () => {
    const h1 = await hashPassword("abcdefghij");
    const h2 = await hashPassword("abcdefghij");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("abcdefghij", h1)).toBe(true);
    expect(await verifyPassword("abcdefghij", h2)).toBe(true);
  });

  it("rejects malformed hashes", async () => {
    expect(await verifyPassword("pw", "")).toBe(false);
    expect(await verifyPassword("pw", "bcrypt$something")).toBe(false);
    expect(await verifyPassword("pw", "scrypt$only$two$fields")).toBe(false);
  });

  it("enforces the minimum length", () => {
    expect(() => validatePasswordStrength("short")).toThrow(/at least/);
    expect(() => validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      /at least/
    );
    expect(() => validatePasswordStrength("a".repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it("rejects empty / non-string password", () => {
    expect(() => validatePasswordStrength(undefined as unknown as string)).toThrow();
    expect(() => validatePasswordStrength(null as unknown as string)).toThrow();
  });
});
