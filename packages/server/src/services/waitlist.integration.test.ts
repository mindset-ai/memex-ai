import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { waitlistEntries } from "../db/schema.js";
import { addWaitlistEntry } from "./waitlist.js";
import { ConflictError, ValidationError } from "../types/errors.js";

// Waitlist isn't account-scoped — entries are orphans by design. Track the emails we
// create and delete them in afterAll rather than relying on cascade.
const createdEmails: string[] = [];

function uniqueEmail(prefix: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${prefix}-${stamp}@example.com`;
  createdEmails.push(email);
  return email;
}

afterAll(async () => {
  if (createdEmails.length) {
    await db
      .delete(waitlistEntries)
      .where(inArray(waitlistEntries.email, createdEmails))
      .catch(() => {});
  }
});

describe("addWaitlistEntry — success", () => {
  it("inserts a row with defaults (deployment='any') and returns it", async () => {
    const email = uniqueEmail("ok");
    const entry = await addWaitlistEntry({
      name: "Alice",
      company: "Acme",
      email,
    });

    expect(entry.id).toBeTruthy();
    expect(entry.name).toBe("Alice");
    expect(entry.company).toBe("Acme");
    expect(entry.email).toBe(email);
    expect(entry.deployment).toBe("any");

    const [row] = await db
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.email, email));
    expect(row).toBeDefined();
    expect(row.name).toBe("Alice");
  });

  it("lowercases + trims the email for storage", async () => {
    const raw = `   MiXeD-${Date.now().toString(36)}@Example.COM  `;
    const expected = raw.trim().toLowerCase();
    createdEmails.push(expected);
    const entry = await addWaitlistEntry({
      name: "Bob",
      company: "X",
      email: raw,
    });
    expect(entry.email).toBe(expected);
  });

  it("accepts one of the valid deployment values", async () => {
    const email = uniqueEmail("dep");
    const entry = await addWaitlistEntry({
      name: "Carol",
      company: "Y",
      email,
      deployment: "self_hosted",
    });
    expect(entry.deployment).toBe("self_hosted");
  });

  it("coerces unknown deployment to 'any'", async () => {
    const email = uniqueEmail("dep-bad");
    const entry = await addWaitlistEntry({
      name: "Dan",
      company: "Z",
      email,
      deployment: "not-a-real-value",
    });
    expect(entry.deployment).toBe("any");
  });
});

describe("addWaitlistEntry — validation", () => {
  it("rejects missing name/company/email", async () => {
    await expect(
      addWaitlistEntry({ name: "", company: "X", email: "a@b.co" })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addWaitlistEntry({ name: "X", company: "", email: "a@b.co" })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      addWaitlistEntry({ name: "X", company: "Y", email: "" })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects fields over 200 chars", async () => {
    const long = "a".repeat(201);
    await expect(
      addWaitlistEntry({ name: long, company: "X", email: "a@b.co" })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects non-email strings", async () => {
    await expect(
      addWaitlistEntry({ name: "X", company: "Y", email: "not an email" })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("addWaitlistEntry — conflict", () => {
  it("raises ConflictError on duplicate email", async () => {
    const email = uniqueEmail("dup");
    await addWaitlistEntry({ name: "First", company: "A", email });
    await expect(
      addWaitlistEntry({ name: "Second", company: "B", email })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
