// Domain errors. The `code` field is an optional machine-readable identifier the
// admin client can switch on; `message` stays the human-readable string already
// surfaced via `error` in JSON responses.
export class DomainError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "Not found", code?: string) {
    super(message, code);
  }
}

export class ValidationError extends DomainError {
  constructor(message = "Validation failed", code?: string) {
    super(message, code);
  }
}

// spec-521 dec-2 (ac-2, ac-3, ac-12) — an agent resolved the ref of an ARCHIVED
// document. The `message` IS the stub (built by formatArchivedDocStub): handle,
// title, archived-at, actor, phase-at-archive, reason, and the restore line —
// never the content.
//
// Deliberately NOT a subclass of NotFoundError. The MCP surface renders
// NotFoundError as `Not found: <message>`, which would read as nonsense in front
// of a stub that exists precisely to say "this Spec is real, it is parked, and
// here is why". It gets its own branch in `handleError` that emits the stub
// verbatim; the in-app agent surface already surfaces `err.message` as-is.
//
// One error covers reads AND writes by design (§5.3): a read of the doc ref wants
// the stub, and a doc-level write wants a refusal that names the Spec as archived
// so the agent stops rather than retries. That is the same sentence, so it is the
// same error. CHILD refs never reach this class — they resolve to a plain
// not-found, indistinguishable from a ref that never existed.
export class ArchivedDocError extends DomainError {
  constructor(message: string, code?: string) {
    super(message, code);
  }
}

export class ConflictError extends DomainError {
  constructor(message = "Conflict", code?: string) {
    super(message, code);
  }
}

export class AuthError extends DomainError {
  constructor(message = "Authentication failed", code?: string) {
    super(message, code);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "Forbidden", code?: string) {
    super(message, code);
  }
}

export class RateLimitError extends DomainError {
  constructor(message = "Too many requests", code?: string) {
    super(message, code);
  }
}
