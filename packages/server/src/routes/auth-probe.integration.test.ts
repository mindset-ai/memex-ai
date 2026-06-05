import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { users } from "../db/schema.js";
import { upsertUserByEmail, createUserWithPassword } from "../services/users.js";

const originalClientId = process.env.GOOGLE_CLIENT_ID;
beforeAll(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  vi.resetModules();
});
afterAll(() => {
  if (originalClientId !== undefined) process.env.GOOGLE_CLIENT_ID = originalClientId;
});

const createdUserIds: string[] = [];
afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

async function appReq(path: string, init: RequestInit = {}) {
  const { app } = await import("../app.js");
  return app.request(path, init);
}

async function probe(email: string) {
  const res = await appReq("/api/auth/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/auth/probe", () => {
  it("returns exists=false for an unknown email", async () => {
    const result = await probe(`unknown-${Date.now()}@memex.ai`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ exists: false, hasPassword: false });
  });

  it("returns exists=true,hasPassword=false for a Google-only user", async () => {
    const email = `google-${Date.now()}@memex.ai`;
    const u = await upsertUserByEmail(email);
    createdUserIds.push(u.id);

    const result = await probe(email);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ exists: true, hasPassword: false });
  });

  it("returns exists=true,hasPassword=true for a password user", async () => {
    const email = `pw-${Date.now()}@memex.ai`;
    const u = await createUserWithPassword({ email, passwordHash: "scrypt$dummy$hash" });
    createdUserIds.push(u.id);

    const result = await probe(email);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ exists: true, hasPassword: true });
  });

  it("normalises email casing", async () => {
    const email = `case-${Date.now()}@memex.ai`;
    const u = await upsertUserByEmail(email);
    createdUserIds.push(u.id);

    const result = await probe(email.toUpperCase());
    expect(result.body.exists).toBe(true);
  });

  it("400s when email is missing", async () => {
    const res = await appReq("/api/auth/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
