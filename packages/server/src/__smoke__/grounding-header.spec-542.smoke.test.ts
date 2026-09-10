// spec-542 ac-3 / t-6 — the grounding state reads correctly ON THE DEPLOYED SYSTEM.
//
// This is the only assertion in spec-542 that a fixture cannot make. Every other
// AC proves the projection and the formatter; this proves the deployed image
// actually renders the header and the single matched claim over real HTTP, on a
// real row, through the real `/mcp`.
//
// ───────────────────────────────────────────────────────────────────────────
// WHY IT DOES NOT ASSERT ON THE REPORTED REF, which ac-3 names.
//
// ac-3 names `mindset-prod/memex-backstage/specs/spec-19`. A smoke test CANNOT
// read it, and the reason is structural rather than incidental: the smoke token
// is scoped to the throwaway `zzz-smoke` tenant, so any real-tenant doc returns
// 404 under std-7 (unauthorized reads are 404, never 403). The authed tier
// already states this in `authed.smoke.test.ts` and resolves it the same way —
// it provisions its own doc and asserts the property on that.
//
// So ac-3's proof is deliberately in two halves, and neither is redundant:
//   • THE REPORTED REF was verified by hand against deployed prod, with a
//     baseline captured BEFORE the release proving it read wrong until then.
//     That read used a credential with access to that tenant. It is recorded on
//     spec-542 t-6 verbatim. It is real, and it is not repeatable.
//   • THE MECHANISM is verified here: automated, repeatable, and — because a
//     smoke run emits — self-proving that it executed.
// Claiming this file covers the reported ref would be exactly the kind of
// almost-true assertion spec-542 exists to stop.
//
// ───────────────────────────────────────────────────────────────────────────
// HOW THIS PROVES IT RAN, which t-6 asks for and a green summary cannot give.
//
// `describe.skipIf` is the established pattern here, and a skipped tier looks
// identical to a passing one in the deploy log — the failure mode this Spec's
// own subject is about. The proof is therefore NOT the suite summary: it is the
// `tagAc` emission below. A smoke run against a deployed host emits a
// test_event for ac-3; a skipped tier emits nothing at all, so ac-3 stays
// `untested` on the board and the skip is VISIBLE as an unverified AC rather
// than hidden behind a green tick.
//
// In other words: ac-3 going green IS the evidence this file ran. That is why
// the assertion lives here rather than in a report anyone could write.
//
// That mechanism was VERIFIED rather than assumed, because a failed emission is
// silent (an expired key 401s with a green suite and an untested AC). Checked
// 2026-09-10 on a sibling smoke AC — spec-167 ac-6, tagged by
// `oauth-consent-allow-button.smoke.test.ts`: 11 emissions, latest pass at
// 2026-09-10T00:11:32.999Z, which is the prod deploy run whose smoke passed at
// 00:11:34. `MEMEX_EMIT_KEY` is wired in `deploy.yml` for exactly this purpose.
// So smoke emissions land, and the board is a truthful execution record.
//
// ───────────────────────────────────────────────────────────────────────────
// PROVEN AGAINST THE DEPLOYED SYSTEM BEFORE BEING SHIPPED.
//
// A smoke test that has never run is a guess. Both bodies below were dry-run
// against deployed prod (https://memex.ai/mcp) before this file was committed,
// using a throwaway Spec in a personal Memex, and 13 of 13 assertions passed.
// The transition they observed:
//
//   before  Code-grounding: none — the resolved decisions have not been checked…
//           ⚠ No code-grounding on this Spec. …
//   after   Code-grounding: verified by Frederic (just now).
//           Code-grounding affirmed by agent.
//
// RED-CAPABILITY, proven from real pre-fix output rather than a synthetic
// mutation: the same three regexes were run against the actual response prod
// returned BEFORE this release (captured on the reported ref and recorded on
// t-6). Against it, `HEADER_NONE` does not match (there was no header line at
// all), `HEADER_VERIFIED` does not match, and `PROSE_CONDITIONAL` DOES match.
// So both tests below would have gone red on the previously deployed image —
// which is the strongest form of red-capability available for a smoke, since
// the input is genuine production output rather than a mutation of the source.

import { describe, it, expect, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  SMOKE_BASE_URL,
  SMOKE_ENV,
  SMOKE_MCP_TOKEN,
  SMOKE_NAMESPACE,
  callMcpTool,
  mcpTextPayload,
} from "./smoke-env.js";

const AC_3 = "mindset-prod/memex-building-itself/specs/spec-542/acs/ac-3";

/** The header line, per grounding state. Anchored to `Code-grounding:`. */
const HEADER_NONE = /^Code-grounding: none — /m;
const HEADER_VERIFIED = /^Code-grounding: verified(?: by .+?)? \(.+?\)\.$/m;

/** The footer claims. Exactly one may appear in any single response. */
const CLAIM_NOT_GROUNDED = /No code-grounding on this Spec/;
const CLAIM_GROUNDED = /Code-grounding affirmed by agent/;
const CLAIM_STALE = /Treat the grounding as out of date/;

/** The prose conditional the fix removed — must appear in NO response. */
const PROSE_CONDITIONAL = /If unverified:/;

/** Pull the first `ref: <ref>` token out of an MCP text payload. */
function parseRef(text: string): string | null {
  const m = text.match(/ref:\s*([^\s")]+)/i);
  return m ? m[1] : null;
}

/** How many of the three mutually exclusive claims appear in one response. */
function claimCount(text: string): number {
  return [CLAIM_NOT_GROUNDED, CLAIM_GROUNDED, CLAIM_STALE].filter((re) =>
    re.test(text),
  ).length;
}

// Everything created lives in the throwaway tenant and is swept idempotently
// (spec-70 dec-2: the suite owns its own island and touches no other namespace).
const createdDocRefs: string[] = [];

describe.skipIf(!SMOKE_MCP_TOKEN)(
  `spec-542 grounding header smoke @ ${SMOKE_BASE_URL} (ENV=${SMOKE_ENV || "?"})`,
  () => {
    afterAll(async () => {
      for (const ref of createdDocRefs.splice(0)) {
        await callMcpTool("update_doc", { ref, status: "done" }).catch(() => {});
      }
    });

    // ONE test, both states, deliberately. Split in two, a deployed image that
    // rendered NO grounding line at all — the defect as reported — would pass
    // the "ungrounded" half on its negative assertions alone. Asserting the
    // transition means the only way to green is for the line to actually exist
    // and to actually change with the state.
    it("an ungrounded Spec reads as ungrounded, and grounding it changes what the deployed read says", async () => {
      tagAc(AC_3);

      const stamp = new Date().toISOString();
      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title: `[smoke] spec-542 grounding header ${stamp}`,
        purpose: "Grounding-header smoke — safe to delete.",
        docType: "spec",
      });
      expect(created.body.result?.isError).toBeFalsy();
      const ref = parseRef(mcpTextPayload(created.body));
      expect(ref, "create_doc should return a canonical ref").toBeTruthy();
      createdDocRefs.push(ref!);

      // ── BEFORE: never grounded ────────────────────────────────────────────
      const before = await callMcpTool("get_doc", { ref: ref!, verbose: true });
      expect(before.status).toBe(200);
      expect(before.body.error).toBeUndefined();
      const beforeText = mcpTextPayload(before.body);

      // Guard against asserting on an empty payload — every negative below
      // would pass on one, which is the silent failure ac-11 exists for.
      expect(
        beforeText.length,
        "the deployed read returned no content to assert on",
      ).toBeGreaterThan(500);

      expect(
        beforeText,
        "the deployed image renders no code-grounding header line at all — this is the defect as reported",
      ).toMatch(HEADER_NONE);
      expect(beforeText).toMatch(CLAIM_NOT_GROUNDED);
      expect(beforeText).not.toMatch(CLAIM_GROUNDED);
      expect(
        claimCount(beforeText),
        "more than one mutually exclusive grounding claim in a single deployed response",
      ).toBe(1);

      // ── GROUND IT ─────────────────────────────────────────────────────────
      // `codebase_present: true` is honest here and not a formality: the deploy
      // job runs this suite from the repository checkout it just built.
      const grounded = await callMcpTool("ground_spec", {
        ref: ref!,
        codebase_present: true,
      });
      expect(
        grounded.body.result?.isError,
        `ground_spec failed on the deployed host: ${mcpTextPayload(grounded.body)}`,
      ).toBeFalsy();

      // ── AFTER: grounded, nothing else touched ─────────────────────────────
      // No decision resolved and no AC written between grounding and reading,
      // so `isGroundingStale` derives false and this is the plain affirmative.
      // (The stale branch is unreachable through a mutating tool — proven in
      // the ac-4 integration test — so it is not asserted here.)
      const after = await callMcpTool("get_doc", { ref: ref!, verbose: true });
      expect(after.status).toBe(200);
      const afterText = mcpTextPayload(after.body);

      expect(
        afterText,
        "the deployed read does not report the grounding, or omits who/when",
      ).toMatch(HEADER_VERIFIED);
      expect(afterText).toMatch(CLAIM_GROUNDED);
      expect(
        afterText,
        "a Spec grounded seconds ago is still being told it has no code-grounding",
      ).not.toMatch(CLAIM_NOT_GROUNDED);
      expect(claimCount(afterText)).toBe(1);

      // ── The transition itself ─────────────────────────────────────────────
      // The root of the defect, stated against the deployed system: before
      // spec-542 these two reads said the same thing about grounding.
      expect(
        beforeText === afterText,
        "the deployed image returned byte-identical output before and after grounding",
      ).toBe(false);
    });

    // The prose conditional, asserted against the deployed image in BOTH states.
    // It is the tell that a condition was written into the sentence instead of
    // evaluated, and its absence is what ac-2 promises a reader.
    it("no deployed response asks the reader to evaluate the condition", async () => {
      tagAc(AC_3);

      const stamp = new Date().toISOString();
      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title: `[smoke] spec-542 prose conditional ${stamp}`,
        purpose: "Prose-conditional smoke — safe to delete.",
        docType: "spec",
      });
      const ref = parseRef(mcpTextPayload(created.body));
      expect(ref).toBeTruthy();
      createdDocRefs.push(ref!);

      const ungrounded = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: ref!, verbose: true })).body,
      );
      expect(ungrounded.length).toBeGreaterThan(500);
      expect(
        ungrounded,
        "the deployed image still ships `If unverified:` on an ungrounded Spec",
      ).not.toMatch(PROSE_CONDITIONAL);

      await callMcpTool("ground_spec", { ref: ref!, codebase_present: true });
      const groundedText = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: ref!, verbose: true })).body,
      );
      expect(
        groundedText,
        "the deployed image still ships `If unverified:` on a grounded Spec",
      ).not.toMatch(PROSE_CONDITIONAL);
    });
  },
);
