import { describe, it, expect, vi, beforeEach } from "vitest";

// b-31 dec-8 (Org-scope) × b-36 (canonical refs):
//
// The /mcp boundary forks three ways for entity resolution:
//   1. `resolveMemex(memex)`       — slug-based (`<ns>/<memex>`).
//   2. `resolveMemexFromEntity()`  — UUID-based (legacy code paths).
//   3. `resolveRef(ref)`           — canonical ref (`<ns>/<memex>/specs/spec-N`).
//
// All three MUST thread the OAuth token's `orgFilter` claim into the
// memex-access gate so a token scoped to Org A cannot reach an entity in Org B.
// Paths 1 and 2 are pinned by other tests; this file pins path 3.
//
// spec-111 t-4 moved path 3's gate from the write-only assertMembershipForMemex
// to the read-aware assertReadAccessForMemex (so a non-member can READ a public
// memex by ref, while writes are blocked downstream). The orgFilter-threading
// contract is unchanged — assertReadAccessForMemex still takes orgFilter as its
// 4th positional arg and forwards it to canReadMemex/canWriteMemex.
//
// Failure mode this test catches: a future edit drops the `orgFilter` arg from
// resolveRefForUser → the Org-scope check silently becomes a no-op for ref-based
// tool calls. The result is a cross-Org leak invisible to existing tests.

vi.mock("../mcp/auth.js", () => ({
  assertReadAccessForMemex: vi.fn(),
}));

vi.mock("../services/resolver.js", () => ({
  resolveRef: vi.fn(),
}));

import { resolveRefForUser } from "../mcp/tools.js";
import { assertReadAccessForMemex } from "../mcp/auth.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";

const USER_ID = "user-1";
const MEMEX_ID = "memex-A";
const ORG_A = "org-acme";
const ORG_B = "org-globex";
const REF = "acme/work/specs/spec-1";

function happyPathResolver() {
  // Mimic the resolver's "found" shape: an entity wrapping a doc with a memexId.
  vi.mocked(resolveCanonicalRef).mockResolvedValue({
    entity: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      doc: { id: "doc-1", memexId: MEMEX_ID, handle: "spec-1", title: "Spec 1" } as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

describe("regression: resolveRefForUser threads orgFilter (b-31 dec-8 × b-36)", () => {
  beforeEach(() => {
    vi.mocked(assertReadAccessForMemex).mockReset();
    vi.mocked(resolveCanonicalRef).mockReset();
  });

  it("PAT path — orgFilter=undefined → assertReadAccessForMemex called with undefined orgFilter (legacy behaviour)", async () => {
    happyPathResolver();
    vi.mocked(assertReadAccessForMemex).mockResolvedValue({ readOnly: false });

    await resolveRefForUser(USER_ID, REF /* orgFilter omitted */);

    expect(assertReadAccessForMemex).toHaveBeenCalledWith(USER_ID, MEMEX_ID, undefined, undefined);
  });

  it("OAuth personal-only — orgFilter=null → forwarded to assertReadAccessForMemex", async () => {
    happyPathResolver();
    vi.mocked(assertReadAccessForMemex).mockResolvedValue({ readOnly: false });

    await resolveRefForUser(USER_ID, REF, null);

    expect(assertReadAccessForMemex).toHaveBeenCalledWith(USER_ID, MEMEX_ID, undefined, null);
  });

  it("OAuth org-scoped — orgFilter=<orgId> → forwarded to assertReadAccessForMemex", async () => {
    happyPathResolver();
    vi.mocked(assertReadAccessForMemex).mockResolvedValue({ readOnly: false });

    await resolveRefForUser(USER_ID, REF, ORG_A);

    expect(assertReadAccessForMemex).toHaveBeenCalledWith(USER_ID, MEMEX_ID, undefined, ORG_A);
  });

  it("cross-Org leak prevention — assertReadAccessForMemex rejection bubbles up (load-bearing)", async () => {
    // Simulate: user is a member of both Org A and Org B, but the OAuth token is
    // scoped to Org A and the ref points at Org B's PRIVATE memex. The read gate
    // (canReadMemex → canWriteMemex with the Org-scope filter) denies, surfacing
    // the std-7 "not found"-style error.
    happyPathResolver();
    vi.mocked(assertReadAccessForMemex).mockRejectedValue(
      new Error(
        'You are not a member of Memex "memex-A". Use list_memexes() to see your Memexes.',
      ),
    );

    await expect(resolveRefForUser(USER_ID, REF, ORG_A)).rejects.toThrow(
      /not a member of Memex/,
    );

    // The 4th positional argument is the OAuth Org scope — must be the same value
    // the caller passed. If a future edit silently drops this, the cross-Org check
    // becomes a no-op and the rejection above stops firing for the leak scenario.
    expect(assertReadAccessForMemex).toHaveBeenCalledWith(USER_ID, MEMEX_ID, undefined, ORG_A);
  });

  it("the orgFilter argument is positional — never invent a value the caller didn't pass", async () => {
    happyPathResolver();
    vi.mocked(assertReadAccessForMemex).mockResolvedValue({ readOnly: false });

    // Three call shapes, each unambiguous about the orgFilter wire value.
    await resolveRefForUser(USER_ID, REF);
    await resolveRefForUser(USER_ID, REF, null);
    await resolveRefForUser(USER_ID, REF, ORG_B);

    const calls = vi.mocked(assertReadAccessForMemex).mock.calls;
    expect(calls[0][3]).toBe(undefined);
    expect(calls[1][3]).toBe(null);
    expect(calls[2][3]).toBe(ORG_B);
  });
});
