// Shared test-fixture helpers for integration tests. Lives outside test-helpers.ts so
// route-level tests (which need email-capture) can pull these without coupling to the
// service-level account-creation helpers.
//
// CapturingSender intentionally lives here rather than next to the production sender —
// it's only used in tests, and grouping it with other test fixtures keeps `email/sender.ts`
// production-only.

import type { EmailMessage, EmailSender } from "./email/sender.js";

export class CapturingSender implements EmailSender {
  public messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
  /** Drop captured messages — call between test cases to keep state isolated. */
  reset(): void {
    this.messages = [];
  }
  /** Most recent captured message, or undefined if none. */
  last(): EmailMessage | undefined {
    return this.messages[this.messages.length - 1];
  }
}

// Generates a unique-per-test email so parallel suites don't collide on the
// users.email unique constraint. Format: <prefix>-<timestamp>-<random>@example.com.
export function uniqueEmail(prefix = "test"): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${id}@example.com`;
}

// Generates a unique-per-test subdomain. Same shape as makeTestMemex uses internally,
// exposed so tests can reserve a subdomain BEFORE creating the account (e.g. when
// driving the account-creation API itself rather than seeding the DB).
export function uniqueSubdomain(prefix = "ts"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
}
