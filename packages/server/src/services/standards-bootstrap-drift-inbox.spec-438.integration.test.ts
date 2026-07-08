// spec-438 t-5 (ac-11/ac-5): a standard discovered by the bootstrap surfaces in
// the EXISTING Drift Inbox as a typed record carrying its provenance — the
// proposed standard (the record is attached to it), its cited evidence (the drift
// note), and the proposing actor (the comment author / std-32 ctx). dec-3: reuse
// the existing drift path ("it can continue to go to drift"); the dedicated
// 'proposed standard' primitive + the other-admin fan-out are deferred to spec-422
// (issue-1). This proves the mechanism the protocol's STEP 4b relies on.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createStandard, flagDrift, getStandard } from "./standards.js";
import { listComments } from "./comments.js";
import { fetchTopic } from "./guidance.js";
import { makeTestMemex } from "./test-helpers.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-438/acs/ac-${n}`;
const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex("boot438drift");
});

describe("spec-438 t-5 — discovered standard surfaces in the Drift Inbox with provenance", () => {
  it("a discovered draft standard, flagged into the inbox, becomes an open drift record carrying evidence + actor (ac-11)", async () => {
    tagAc(AC(11));
    // the bootstrap authors the discovered rule as a standard (born 'approved'
    // since spec-449 removed the draft/approved lifecycle; the "unratified"
    // signal now lives in the Drift Inbox below, not in a status)...
    const std = await createStandard(memexId, {
      title: "Inputs are validated at the boundary",
      sections: [{ sectionType: "rule", content: "Validate all external input at the API boundary." }],
    });
    createdDocIds.push(std.id);
    expect(std.status).toBe("approved");
    const ruleSection = std.sections.find((s) => s.sectionType === "rule")!;

    // ...then surfaces it for review via the EXISTING drift path (STEP 4b),
    // citing the evidence, authored by the proposing admin.
    await flagDrift(
      memexId,
      ruleSection.id,
      "Newly discovered rule proposed from the codebase. Evidence: request handlers call a shared validate() at every entrypoint.",
      { authorName: "Ada (admin)" },
    );

    // it now surfaces in the existing Drift Inbox (the standard's open drift count)
    const reloaded = await getStandard(memexId, std.id);
    expect(reloaded.driftCount).toBe(1);

    // the typed record carries provenance: type=drift, the cited evidence, the actor
    const comments = await listComments(memexId, ruleSection.id);
    const drift = comments.find((c) => c.commentType === "drift");
    expect(drift, "a drift-typed record must exist on the discovered standard").toBeTruthy();
    expect(drift!.content).toMatch(/Evidence:/);
    expect(drift!.authorName).toBe("Ada (admin)");
  });

  it("the protocol surfaces discovered standards to the drift inbox and defers the fan-out to the attention engine (ac-5)", async () => {
    tagAc(AC(5));
    const { body } = await fetchTopic("standards-bootstrap");
    // it uses the existing drift path with cited evidence
    expect(body).toContain("flag_drift");
    expect(body).toMatch(/drift inbox/i);
    expect(body).toMatch(/citing the same evidence|evidence you showed/i);
    // and it does NOT build the other-admin fan-out — that is the attention engine's job
    expect(body).toMatch(/do not route it to specific people|don't route|attention engine can later/i);
  });
});
