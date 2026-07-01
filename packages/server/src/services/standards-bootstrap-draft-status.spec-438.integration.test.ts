// spec-438 t-3 (ac-10): a standard authored by the bootstrap protocol lands as
// `draft`, and no bootstrap code path promotes it to `active`. The protocol
// authors through the standard create path (create_doc docType:'standard' ->
// createStandard); this pins that path to draft and guards the protocol prose
// against instructing activation. Promotion to active is the admin's later act.

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createStandard } from "./standards.js";
import { fetchTopic } from "./guidance.js";
import { makeTestMemex } from "./test-helpers.js";

const AC10 = "mindset-prod/memex-building-itself/specs/spec-438/acs/ac-10";
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

describe("spec-438 t-3 — bootstrap standards land as draft (ac-10)", () => {
  it("a standard authored through the bootstrap create path is status 'draft'", async () => {
    tagAc(AC10);
    const std = await createStandard(memexId, {
      title: "How we handle secrets",
      description: "Discovered by the cold-start bootstrap",
      sections: [
        { sectionType: "rule", content: "Secrets are read from the environment, never committed." },
        { sectionType: "rationale", content: "A committed secret is a permanent leak." },
      ],
    });
    createdDocIds.push(std.id);
    expect(std.status).toBe("draft");
  });

  it("the bootstrap protocol prose never instructs promotion to active", async () => {
    tagAc(AC10);
    const { body } = await fetchTopic("standards-bootstrap");
    // the protocol saves drafts and hands ratification to the admin later — it
    // must not tell the agent to activate / publish-as-active / promote a standard.
    expect(body).not.toMatch(/set[^.]*\bactive\b|mark[^.]*\bactive\b|promote to active|activate the standard|publish (it|the standard) as active/i);
  });
});
