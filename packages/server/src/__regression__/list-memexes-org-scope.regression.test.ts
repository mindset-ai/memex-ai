import { describe, it, expect } from "vitest";
import { filterMembershipsForOrgScope } from "../mcp/tools.js";

// b-31 dec-8: OAuth tokens are Org-scoped — they grant access to the user's
// personal Memex + one chosen Org. PAT callers (mxt_) MUST remain user-wide
// (no regression).
//
// This regression pins the filter rule for every shape of orgFilter:
//   - undefined → PAT path; see everything (no regression).
//   - null      → OAuth, personal-only grant; see personal only.
//   - <orgId>   → OAuth, org-scoped grant; see personal + that Org.
//
// If this test fails, an OAuth caller can suddenly see Memexes outside the
// granted Org scope — a silent cross-Org leak. Promote any failure to a
// blocker.

interface FakeMembership {
  memexId: string;
  kind: "personal" | "team";
  orgId?: string;
  label: string;
}

const PERSONAL: FakeMembership = {
  memexId: "m-personal",
  kind: "personal",
  label: "personal",
};

const ACME_A: FakeMembership = {
  memexId: "m-acme-a",
  kind: "team",
  orgId: "org-acme",
  label: "acme/a",
};

const ACME_B: FakeMembership = {
  memexId: "m-acme-b",
  kind: "team",
  orgId: "org-acme",
  label: "acme/b",
};

const GLOBEX: FakeMembership = {
  memexId: "m-globex",
  kind: "team",
  orgId: "org-globex",
  label: "globex/main",
};

const ALL = [PERSONAL, ACME_A, ACME_B, GLOBEX];

describe("regression: list_memexes Org-scope filter (b-31 dec-8)", () => {
  describe("PAT path — orgFilter === undefined", () => {
    it("returns every membership unchanged (no regression)", () => {
      const result = filterMembershipsForOrgScope(ALL, undefined);
      expect(result).toEqual(ALL);
    });

    it("the user with zero Orgs sees their personal Memex", () => {
      const result = filterMembershipsForOrgScope([PERSONAL], undefined);
      expect(result).toEqual([PERSONAL]);
    });
  });

  describe("OAuth personal-only — orgFilter === null", () => {
    it("returns ONLY the personal Memex", () => {
      const result = filterMembershipsForOrgScope(ALL, null);
      expect(result).toEqual([PERSONAL]);
    });

    it("user with no Org memberships sees their personal Memex", () => {
      const result = filterMembershipsForOrgScope([PERSONAL], null);
      expect(result).toEqual([PERSONAL]);
    });

    it("user with only Org memberships (no personal — synthetic) sees nothing", () => {
      // Shouldn't happen in production (every user has a personal namespace)
      // but the filter rule still holds: personal-only token + zero personal
      // memexes = empty list.
      const result = filterMembershipsForOrgScope([ACME_A, GLOBEX], null);
      expect(result).toEqual([]);
    });
  });

  describe("OAuth org-scoped — orgFilter === <orgId>", () => {
    it("returns personal + every Memex in the chosen Org", () => {
      const result = filterMembershipsForOrgScope(ALL, "org-acme");
      expect(result).toEqual([PERSONAL, ACME_A, ACME_B]);
    });

    it("excludes Memexes from OTHER Orgs (the load-bearing assertion)", () => {
      const result = filterMembershipsForOrgScope(ALL, "org-acme");
      expect(result).not.toContain(GLOBEX);
    });

    it("scoping to an Org the user doesn't belong to yields only personal", () => {
      // The membership list itself wouldn't include `org-unknown`, but if a
      // stale token claims it, we should still return only the personal
      // memex — never invent an Org match.
      const result = filterMembershipsForOrgScope(ALL, "org-unknown");
      expect(result).toEqual([PERSONAL]);
    });
  });

  describe("the boundary between PAT and OAuth", () => {
    it("the PAT path is the SAME as undefined; an explicit undefined arg matches the implicit one", () => {
      const pat = filterMembershipsForOrgScope(ALL, undefined);
      // Sanity: there's no path through the function that produces undefined
      // unless the caller passed it explicitly. PAT-vs-OAuth invariant.
      expect(pat.length).toBe(ALL.length);
    });

    it("a falsy-but-not-undefined input is NOT treated as PAT", () => {
      // null and "" are both falsy in JS. null = personal-only OAuth; we
      // never expect "" (TypeScript blocks it). Both must NOT collapse to
      // the PAT path.
      expect(filterMembershipsForOrgScope(ALL, null)).toEqual([PERSONAL]);
    });
  });
});
