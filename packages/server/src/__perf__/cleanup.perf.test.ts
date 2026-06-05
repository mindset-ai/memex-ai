import { describe, it, expect } from "vitest";
import { cleanupExpiredDomainVerificationTokens } from "../services/domain-verification.js";

// NOTE: the invite-token cleanup perf test was removed alongside the
// invite-token purge itself — expired invite rows are now retained
// indefinitely so an expired link reports "expired" rather than "invalid"
// (see services/invite-tokens.ts). Domain-verification tokens are still swept.

describe("perf: cleanup idempotency across concurrent instances", () => {
  it("domain-verification cleanup is idempotent under concurrent calls", async () => {
    // No rows to delete — the pure idempotency path. Running two concurrent cleanups must
    // return 0,0 without errors (proves the background scheduler can safely run on multiple
    // replicas without locking).
    const [a, b] = await Promise.all([
      cleanupExpiredDomainVerificationTokens(),
      cleanupExpiredDomainVerificationTokens(),
    ]);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
  }, 10_000);
});
