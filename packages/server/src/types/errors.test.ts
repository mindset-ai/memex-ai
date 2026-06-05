import { describe, it, expect } from "vitest";
import {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  AuthError,
  ForbiddenError,
  RateLimitError,
} from "./errors.js";

describe("DomainError hierarchy", () => {
  it("DomainError carries message + optional code; name reflects subclass", () => {
    const err = new DomainError("nope", "BAD_THING");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("nope");
    expect(err.code).toBe("BAD_THING");
    expect(err.name).toBe("DomainError");
  });

  it("subclass instances have correct names and pass instanceof", () => {
    const cases: Array<[new (...args: never[]) => DomainError, string]> = [
      [NotFoundError, "NotFoundError"],
      [ValidationError, "ValidationError"],
      [ConflictError, "ConflictError"],
      [AuthError, "AuthError"],
      [ForbiddenError, "ForbiddenError"],
      [RateLimitError, "RateLimitError"],
    ];
    for (const [Cls, name] of cases) {
      // @ts-expect-error — argument typing isn't important for the test
      const err = new Cls("msg", "CODE");
      expect(err).toBeInstanceOf(Cls);
      expect(err).toBeInstanceOf(DomainError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
      expect(err.code).toBe("CODE");
    }
  });

  it("subclasses accept default messages", () => {
    expect(new NotFoundError().message).toBe("Not found");
    expect(new ValidationError().message).toBe("Validation failed");
    expect(new ConflictError().message).toBe("Conflict");
    expect(new AuthError().message).toBe("Authentication failed");
    expect(new ForbiddenError().message).toBe("Forbidden");
    expect(new RateLimitError().message).toBe("Too many requests");
  });

  it("code is undefined when omitted", () => {
    expect(new ValidationError("x").code).toBeUndefined();
  });
});
