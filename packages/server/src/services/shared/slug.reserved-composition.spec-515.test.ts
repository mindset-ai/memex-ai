// spec-515 t-7 / ac-5, ac-10 — the two reserved vocabularies are composed, not
// hand-synced.
//
// THE INTERLOCK. A word that is simultaneously an API mount root and a namespace
// slug makes one of the two unreachable, in either direction:
//
//   slug shadows an API root → that route's subpaths go into tenant resolution and
//                              404 before the handler runs (the spec-515 defect)
//   API root claimed as slug → memexResolver stops resolving the word, so that
//                              tenant becomes unroutable
//
// Before this, the two lists were maintained by hand and shared only **6 entries
// out of 27 and 28**. std-3 cl-7 (amended 2026-07-28) now states the rule: the
// reserved-slug list is the union of the app/marketing words and the API roots.
//
// These assertions are what make the Standard's promise true in code. cl-7 is
// classified `config-parity`, i.e. the Standard explicitly claims a test proves the
// two agree — this is that test.

import { describe, expect, it } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { reservedApiRoots } from "../../routes/api-roots.js";
import { parseMemexPath } from "../../middleware/memex-resolver.js";
import { RESERVED_SLUGS, validateSlugFormat } from "./slug.js";

const AC_INVARIANT = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-5";
const AC_COMPOSITION = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-10";

describe("RESERVED_SLUGS composition (spec-515 t-7)", () => {
  it("rejects every reserved API root as a namespace slug", () => {
    tagAc(AC_COMPOSITION);
    const claimable = [...reservedApiRoots()].filter((root) => {
      // `__test__` cannot be a slug regardless — the grammar rejects underscores,
      // so it fails as `invalid_chars` rather than `reserved`. Both are refusals.
      const verdict = validateSlugFormat(root);
      return verdict.valid;
    });
    expect(claimable).toEqual([]);
  });

  it("reports reserved API roots as `reserved`, not merely malformed", () => {
    // A word rejected for the right reason produces the right error for the user.
    tagAc(AC_COMPOSITION);
    for (const root of ["email", "test-events", "acs", "issues", "hook-keys"]) {
      expect(validateSlugFormat(root)).toEqual({ valid: false, error: "reserved" });
    }
  });

  it("adding an API root reserves its slug with no second edit", () => {
    // The composition, asserted structurally: RESERVED_SLUGS is a SUPERSET of the
    // API roots. Nothing to remember to update — declaring a root is the only act.
    tagAc(AC_COMPOSITION);
    const missing = [...reservedApiRoots()].filter((r) => !RESERVED_SLUGS.has(r));
    expect(missing).toEqual([]);
  });

  it("holds the invariant in BOTH directions for every flat mount root", () => {
    // ac-5. Direction 1: the root is exempt from tenant parsing, so its subpaths
    // reach the router. Direction 2: the root is unclaimable as a slug, so no
    // tenant can ever shadow it. Either half alone leaves a live defect.
    tagAc(AC_INVARIANT);
    const broken: string[] = [];
    for (const root of reservedApiRoots()) {
      if (parseMemexPath(`/api/${root}/anything`) !== null) {
        broken.push(`${root}: NOT exempt from tenant parsing`);
      }
      if (validateSlugFormat(root).valid) {
        broken.push(`${root}: still claimable as a namespace slug`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("still reserves the app-utility and marketing words", () => {
    // Regression guard: composing the list must not drop what it already covered.
    tagAc(AC_COMPOSITION);
    for (const word of [
      "login",
      "signup",
      "settings",
      "admin",
      "memex",
      "pricing",
      "story",
      "writing",
      "research",
      "coding-agents",
      "legal",
      "branding",
      "get-started",
      "community",
    ]) {
      expect(validateSlugFormat(word)).toEqual({ valid: false, error: "reserved" });
    }
  });

  it("keeps the marketing group equal to the apex→www redirect set", () => {
    // std-3 cl-6(b) names the `memex-app-lb` URL map as the authority. Verified
    // against the live prod URL map on 2026-07-28: these ten are exactly the
    // single-segment paths it redirects apex→www. Dotted paths it also redirects
    // (`llms.txt`, `rss.xml`, `sitemap.xml`, `docs.html`, `story.html`) need no
    // entry — the slug grammar rejects dots.
    tagAc(AC_COMPOSITION);
    for (const word of [
      "docs",
      "pricing",
      "story",
      "community",
      "writing",
      "legal",
      "research",
      "coding-agents",
      "get-started",
      "branding",
    ]) {
      expect(RESERVED_SLUGS.has(word)).toBe(true);
    }
  });

  it("does not over-reserve — an ordinary slug is still available", () => {
    tagAc(AC_COMPOSITION);
    expect(validateSlugFormat("acme-corp")).toEqual({ valid: true });
    expect(validateSlugFormat("frederic")).toEqual({ valid: true });
  });
});
