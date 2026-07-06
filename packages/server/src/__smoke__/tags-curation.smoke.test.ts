// Post-deploy smoke — AUTHED tag-catalogue curation (spec-418 t-8 / ac-40).
//
// Drives an authed create → RENAME → delete journey for the tag-catalogue
// curation tools (create_tag / rename_tag / delete_tag, shipped by t-4) over the
// LIVE `/mcp` endpoint, using the shared smoke-env helpers (callMcpTool, SMOKE_*
// env). It mirrors authed.smoke.test.ts's create→…→delete journey and lives in
// the same throwaway namespace (SMOKE_NAMESPACE, default `zzz-smoke`), self-
// cleaning idempotently so it can never leave the shared host dirty (dec-2/dec-6).
//
// ac-40 is a POST-DEPLOY check: it verifies the deployed contract against int
// AFTER a deploy, and green smoke gates prod promotion (std-17). It is authored +
// review-verified now; it EXECUTES post-int-deploy once the smoke `mxt_` token
// (provisioned by the PAM-gated t-9) is present. Until then the whole tier SKIPS
// CLEANLY via `describe.skipIf(!SMOKE_MCP_TOKEN)` — the deploy-tail run stays green
// where creds are absent (dec-3/dec-5).
//
// Unlike the create→read→delete doc journey, the tag curation tools return a
// human-readable text payload and there is no MCP read tool for the catalogue, so
// each step is asserted on its OWN MCP response text: create confirms the coined
// tag, rename reflects the new name (old → new), delete confirms removal.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  SMOKE_BASE_URL,
  SMOKE_MCP_TOKEN,
  SMOKE_NAMESPACE,
  callMcpTool,
  mcpTextPayload,
} from "./smoke-env.js";

// The tag currently live in the catalogue, tracked so afterAll can best-effort
// delete whatever the journey left behind (its label changes across the rename).
let liveTag: string | null = null;

async function deleteTagQuiet(tag: string): Promise<void> {
  try {
    await callMcpTool("delete_tag", { memex: SMOKE_NAMESPACE, tag });
  } catch {
    // Idempotent teardown: a tag already gone (or never created) is fine.
  }
}

describe.skipIf(!SMOKE_MCP_TOKEN)(
  `authed tag-curation smoke @ ${SMOKE_BASE_URL} (ns=${SMOKE_NAMESPACE})`,
  () => {
    beforeAll(() => {
      // Guard rail (dec-2): refuse to run authed write journeys against anything
      // that doesn't read as a throwaway namespace, so a misconfigured token can
      // never mutate real data on shared int/prod. Mirrors authed.smoke.test.ts.
      if (!/smoke/i.test(SMOKE_NAMESPACE)) {
        throw new Error(
          `Refusing to run authed smoke writes against namespace "${SMOKE_NAMESPACE}" — ` +
            `it must be an obvious throwaway (contain "smoke"). Set SMOKE_NAMESPACE.`,
        );
      }
    });

    afterAll(async () => {
      // Idempotent sweep of whatever the journey left in the catalogue.
      if (liveTag) {
        await deleteTagQuiet(liveTag);
        liveTag = null;
      }
    });

    // ── spec-418 t-8 (ac-40): the tag-catalogue curation surface on the LIVE
    //    /mcp endpoint. A coding agent coins a throwaway scoped tag, renames it,
    //    then deletes it — all inside the throwaway namespace, self-cleaning. This
    //    is the deployed-contract probe for create_tag / rename_tag / delete_tag:
    //    it catches the class of bug local suites miss (tool not registered on the
    //    deployed image, curation service/migration 0125 missing from the target
    //    env). Each step asserts its OWN response text (no MCP catalogue read).
    it("tag curation: create_tag → rename_tag → delete_tag over /mcp (spec-418)", async () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-418/acs/ac-40");
      // A unique scoped tag so parallel/re-runs never collide. Sanitise the stamp
      // to alnum-hyphen so the value can never smuggle a `::` (which parseTagInput
      // would re-split) or a control char.
      const stamp = new Date().toISOString().replace(/[^0-9a-z]/gi, "-").toLowerCase();
      const scope = "smoke-scope";
      const initialTag = `${scope}::val-${stamp}`;
      const renamedTag = `${scope}::val-${stamp}-renamed`;

      // CREATE — coin a brand-new catalogue tag in the throwaway memex.
      const created = await callMcpTool("create_tag", {
        memex: SMOKE_NAMESPACE,
        tag: initialTag,
      });
      expect(created.status).toBe(200);
      expect(created.body.result?.isError).toBeFalsy();
      const createdText = mcpTextPayload(created.body);
      expect(createdText).toContain("Created tag");
      expect(createdText).toContain(initialTag);
      liveTag = initialTag; // track for teardown from here on.

      // RENAME — the response must reflect the NEW name (old → new). renameTag
      // fans the change across every Spec carrying it; on no Spec here (a fresh
      // catalogue tag) the per-scope exclusivity guard can't fire.
      const renamed = await callMcpTool("rename_tag", {
        memex: SMOKE_NAMESPACE,
        tag: initialTag,
        newTag: renamedTag,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.result?.isError).toBeFalsy();
      const renamedText = mcpTextPayload(renamed.body);
      expect(renamedText).toContain("Renamed tag");
      // The rename reflects the new name: the handler renders `<old> → <new>`.
      expect(renamedText).toContain(renamedTag);
      liveTag = renamedTag; // catalogue row now carries the new label.

      // DELETE — the genuine destructive primitive; removes the tag we coined.
      const deleted = await callMcpTool("delete_tag", {
        memex: SMOKE_NAMESPACE,
        tag: renamedTag,
      });
      expect(deleted.status).toBe(200);
      expect(deleted.body.result?.isError).toBeFalsy();
      const deletedText = mcpTextPayload(deleted.body);
      expect(deletedText).toContain("Deleted tag");
      expect(deletedText).toContain(renamedTag);
      liveTag = null; // swept — afterAll must not try again.

      // VERIFY the delete landed — deleting the now-removed tag must error
      // (delete_tag 404s an unknown tag via findTagCI → NotFoundError). This
      // proves the row is gone from the catalogue on the deployed image, standing
      // in for the absent MCP catalogue-read tool.
      const reDelete = await callMcpTool("delete_tag", {
        memex: SMOKE_NAMESPACE,
        tag: renamedTag,
      });
      const reDeleteIsError =
        !!reDelete.body.error || reDelete.body.result?.isError === true;
      expect(reDeleteIsError).toBe(true);
    });
  },
);
