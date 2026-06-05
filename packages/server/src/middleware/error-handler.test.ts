import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { errorHandler } from "./error-handler.js";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  AuthError,
  ForbiddenError,
  RateLimitError,
} from "../types/errors.js";

const app = new Hono();
app.onError(errorHandler);

// Routes that throw specific errors
app.get("/not-found", () => {
  throw new NotFoundError("Resource not found");
});

app.get("/validation", () => {
  throw new ValidationError("Invalid input");
});

app.get("/unexpected", () => {
  throw new Error("Something broke");
});

describe("errorHandler", () => {
  it("returns 404 for NotFoundError", async () => {
    const res = await app.request("/not-found");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body).toEqual({ error: "Resource not found" });
  });

  it("returns 400 for ValidationError", async () => {
    const res = await app.request("/validation");
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toEqual({ error: "Invalid input" });
  });

  it("returns 500 for unexpected errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request("/unexpected");
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// Batch 1 expansion: new DomainError subclasses + optional `code` field on the response.
function appThatThrows(err: unknown) {
  const a = new Hono();
  a.onError(errorHandler);
  a.get("/boom", () => {
    throw err;
  });
  return a;
}

describe("errorHandler — extended subclasses", () => {
  it("maps ConflictError → 409", async () => {
    const res = await appThatThrows(new ConflictError("dup")).request("/boom");
    expect(res.status).toBe(409);
  });

  it("maps AuthError → 401", async () => {
    const res = await appThatThrows(new AuthError("nope")).request("/boom");
    expect(res.status).toBe(401);
  });

  it("maps ForbiddenError → 403", async () => {
    const res = await appThatThrows(new ForbiddenError("nope")).request("/boom");
    expect(res.status).toBe(403);
  });

  it("maps RateLimitError → 429", async () => {
    const res = await appThatThrows(new RateLimitError("slow")).request("/boom");
    expect(res.status).toBe(429);
  });

  it("includes optional code field when set", async () => {
    const res = await appThatThrows(
      new ValidationError("bad input", "INVALID_EMAIL"),
    ).request("/boom");
    expect(await res.json()).toEqual({ error: "bad input", code: "INVALID_EMAIL" });
  });

  it("omits code when not set (back-compat)", async () => {
    const res = await appThatThrows(new ValidationError("bad input")).request("/boom");
    expect(await res.json()).toEqual({ error: "bad input" });
  });
});
