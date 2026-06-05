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
