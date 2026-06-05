import type { ErrorHandler } from "hono";
import {
  AuthError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../types/errors.js";

const STATUS_BY_ERROR: ReadonlyArray<[new (...args: never[]) => DomainError, number]> = [
  [NotFoundError, 404],
  [ValidationError, 400],
  [ConflictError, 409],
  [AuthError, 401],
  [ForbiddenError, 403],
  [RateLimitError, 429],
];

// Response shape: `{ error: <human message>, code?: <machine code> }`.
// `error` stays as the human message for back-compat with existing admin callers
// that read `body.error`; new `code` field is purely additive.
export const errorHandler: ErrorHandler = (err, c) => {
  for (const [Cls, status] of STATUS_BY_ERROR) {
    if (err instanceof Cls) {
      const body: { error: string; code?: string } = { error: err.message };
      if (err.code) body.code = err.code;
      return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 429);
    }
  }

  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
};
