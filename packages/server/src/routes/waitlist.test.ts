import { describe, it, expect, vi, beforeEach } from "vitest";
import { testMutate } from "../services/__test__/mutate-helpers.js";
import { Hono } from "hono";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/waitlist.js", () => ({
  addWaitlistEntry: vi.fn(),
}));

import { waitlist } from "./waitlist.js";
import { addWaitlistEntry } from "../services/waitlist.js";
import { ConflictError, ValidationError } from "../types/errors.js";

const app = new Hono();
app.onError(errorHandler);
app.route("/api/waitlist", waitlist);

const baseDate = new Date("2026-04-15T12:00:00Z");

describe("POST /api/waitlist", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a waitlist entry and returns 201", async () => {
    vi.mocked(addWaitlistEntry).mockResolvedValue(testMutate({
      id: "uuid-1",
      name: "Jane Doe",
      company: "Acme",
      email: "jane@acme.com",
      deployment: "cloud",
      createdAt: baseDate,
    }));

    const res = await app.request("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        deployment: "cloud",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe("uuid-1");
    expect(body.createdAt).toBe(baseDate.toISOString());
    // spec-156 FINDING 3: the route threads { channel: "rest_ui" } so the
    // waitlist_entry.created event is attributed to the REST surface (the
    // unauthenticated marketing form) rather than the channel:'server' default.
    expect(addWaitlistEntry).toHaveBeenCalledWith(
      {
        name: "Jane Doe",
        company: "Acme",
        email: "jane@acme.com",
        deployment: "cloud",
      },
      { channel: "rest_ui" },
    );
  });

  it("passes through deployment when omitted so the service can default it", async () => {
    vi.mocked(addWaitlistEntry).mockResolvedValue(testMutate({
      id: "uuid-2",
      name: "Sam",
      company: "Acme",
      email: "sam@acme.com",
      deployment: "any",
      createdAt: baseDate,
    }));

    const res = await app.request("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sam", company: "Acme", email: "sam@acme.com" }),
    });

    expect(res.status).toBe(201);
    expect(addWaitlistEntry).toHaveBeenCalledWith(
      {
        name: "Sam",
        company: "Acme",
        email: "sam@acme.com",
        deployment: undefined,
      },
      { channel: "rest_ui" },
    );
  });

  it("returns 400 when the body is missing fields", async () => {
    vi.mocked(addWaitlistEntry).mockRejectedValue(
      new ValidationError("name, company, and email are required")
    );

    const res = await app.request("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Jane", email: "jane@acme.com" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("required");
  });

  it("returns 409 when the email already exists", async () => {
    vi.mocked(addWaitlistEntry).mockRejectedValue(
      new ConflictError("That email is already on the waitlist")
    );

    const res = await app.request("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Jane", company: "Acme", email: "jane@acme.com" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already");
  });

  it("returns 400 for non-JSON bodies", async () => {
    const res = await app.request("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });

    expect(res.status).toBe(400);
  });
});
