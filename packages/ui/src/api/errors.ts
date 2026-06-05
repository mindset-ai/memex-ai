// Base class for all admin API errors. Subclasses preserve their existing fields
// (`reason`, `errorCode`, `code`) for back-compat; the shared `status` and optional
// `code` give callers a uniform way to switch on transport-level outcomes.
//
// Lives outside client.ts so Batch 4's fetchJson wrapper can import without pulling
// in the rest of the (still-being-decomposed) client surface.
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string) {
    super(404, message);
  }
}

// Thrown by email/password + magic-link endpoints. `reason` preserves the server's
// machine-readable error key (e.g. "expired_token", "invalid_password").
export class AuthApiError extends ApiError {
  constructor(
    status: number,
    public readonly reason: string | undefined,
    message: string,
  ) {
    super(status, message, reason);
  }
}

// Thrown by /orgs endpoints. `errorCode` is the server's `error` field
// (machine code), `reason` is a human-or-context string. Kept distinct from
// `message` because existing call sites read all three independently. Covers
// Org/Memex/Namespace failures per the doc-15 namespace/org/memex split.
export class OrgApiError extends ApiError {
  constructor(
    status: number,
    public readonly errorCode: string | undefined,
    public readonly reason: string | undefined,
    message: string,
  ) {
    super(status, message, errorCode);
  }
}

// Thrown by /account/members PATCH endpoints.
export class MemberApiError extends ApiError {
  constructor(status: number, code: string | undefined, message: string) {
    super(status, message, code);
  }
}

// Thrown by GET /share/:token (public). No HTTP status because some callers care
// only about the `reason` discriminator.
export class ShareAccessError extends ApiError {
  constructor(
    public readonly reason: "unknown" | "revoked",
    message: string,
  ) {
    super(reason === "revoked" ? 410 : 404, message, reason);
  }
}
