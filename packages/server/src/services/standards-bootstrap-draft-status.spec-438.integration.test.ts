// spec-438 t-3 (ac-10) — SUPERSEDED by spec-449 (dec-1/dec-5).
// Originally: a bootstrap-authored standard landed as `draft`, promoted to active
// by the admin later. spec-449 removed the draft/approved status concept from
// Standards entirely — a Standard is in force the moment it exists (born
// `approved`). The "unratified proposal" signal did not disappear: it moved
// wholly to the Drift Inbox (flag_drift, STEP 4b — see the sibling
// standards-bootstrap-drift-inbox.spec-438 test, ac-11/ac-5, still in force).
// What remains true here: the protocol authors through the standard create path
// (createStandard), and its prose must never instruct promotion/activation —
// now trivially, because there is no status to promote.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createStandard } from "./standards.js";
import { fetchTopic } from "./guidance.js";
import { makeTestMemex } from "./test-helpers.js";

const AC10 = "mindset-prod/memex-building-itself/specs/spec-438/acs/ac-10";
// spec-449 dec-5 ac-12: the bootstrap path now mints an 'approved' standard; this
// test verifies that superseding claim, so it's dual-tagged to spec-449 ac-12.
const AC12 = "mindset-prod/memex-building-itself/specs/spec-449/acs/ac-12";
const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex("bootstrap438");
});

describe("spec-438 t-3 — bootstrap standards (ac-10, superseded by spec-449)", () => {
  it("a standard authored through the bootstrap create path is born 'approved' (spec-449)", async () => {
    tagAc(AC10);
    tagAc(AC12);
    const std = await createStandard(memexId, {
      title: "How we handle secrets",
      description: "Discovered by the cold-start bootstrap",
      sections: [
        { sectionType: "rule", content: "Secrets are read from the environment, never committed." },
        { sectionType: "rationale", content: "A committed secret is a permanent leak." },
      ],
    });
    createdDocIds.push(std.id);
    // spec-449 dec-1/dec-5: born 'approved', not 'draft' — the draft/approved
    // lifecycle was removed for Standards; ratification lives in the Drift Inbox.
    expect(std.status).toBe("approved");
  });

  it("the bootstrap protocol prose never instructs promotion to active", async () => {
    tagAc(AC10);
    const { body } = await fetchTopic("standards-bootstrap");
    // the protocol saves drafts and hands ratification to the admin later — it
    // must not tell the agent to activate / publish-as-active / promote a standard.
    expect(body).not.toMatch(/set[^.]*\bactive\b|mark[^.]*\bactive\b|promote to active|activate the standard|publish (it|the standard) as active/i);
  });
});
