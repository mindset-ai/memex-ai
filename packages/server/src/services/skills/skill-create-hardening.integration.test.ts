// spec-300 t-12 (issue-1) + t-13 (issue-3) — createSkill hardening.
//
// Two guarantees the original create path lacked:
//   ac-43 — an invalid SKILL.md rejects as a ValidationError (→ 400 / MCP
//           "Validation error"), never a bare Error that fell through to a 500.
//   ac-44 — a failure while persisting an auxiliary file rolls the whole create
//           back atomically, leaving NO orphan skill document (the observed
//           skill-2 bug: doc committed, files failed, 500 returned).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Force the blob write to fail so we exercise the create-time storage-failure
// window WITHOUT a real bucket. importActual keeps the other exports
// (skillBlobKey / checksumOf / deleteSkillBlob) real, so the rollback's
// best-effort blob cleanup still runs against the local provider.
vi.mock("./skill-storage.js", async () => {
  const actual =
    await vi.importActual<typeof import("./skill-storage.js")>("./skill-storage.js");
  return {
    ...actual,
    putSkillBlob: vi.fn(async () => {
      throw new Error("simulated blob store failure");
    }),
  };
});

import { db } from "../../db/connection.js";
import { documents, memexes } from "../../db/schema.js";
import { ValidationError } from "../../types/errors.js";
import { makeTestMemex } from "../test-helpers.js";
import { createSkill, listSkills } from "./skills-service.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";

const ac = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-300/acs/ac-${n}`;

let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("skl-harden");
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, [memexId])).catch(() => {});
});

describe("createSkill hardening (spec-300 issue-1 / issue-3)", () => {
  it("rejects an invalid SKILL.md as a ValidationError, not a bare Error (ac-43)", async () => {
    tagAc(ac(43));

    // No frontmatter at all — a plain Markdown doc, exactly what a user pasted
    // when this produced an opaque 500.
    await expect(
      createSkill(memexId, { skillMd: "# heading only\n\nno frontmatter" }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Frontmatter present but a required field (name) missing/blank.
    await expect(
      createSkill(memexId, {
        skillMd: "---\ndescription: only a description\n---\n# x\n",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rolls back atomically when a binary aux file fails to store — no orphan (ac-44)", async () => {
    tagAc(ac(44));

    const md = reconstructSkillMd({
      name: "rollback-check",
      description: "Use when: verifying create rolls back on a storage failure.",
      body: "# Rollback check\n\nBody.",
    });

    // The doc commits (step 1) before the binary blob upload (step 3) throws — the
    // exact window that used to orphan a skill.
    await expect(
      createSkill(memexId, {
        skillMd: md,
        files: [
          {
            path: "assets/x.bin",
            contentType: "application/octet-stream",
            bytes: new Uint8Array([1, 2, 3, 4]),
          },
        ],
      }),
    ).rejects.toThrow(/blob store failure/i);

    // No orphan: neither the service listing nor the raw documents table shows it.
    const skills = await listSkills(memexId);
    expect(skills.find((s) => s.name === "rollback-check")).toBeUndefined();

    const rows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(eq(documents.memexId, memexId), eq(documents.title, "rollback-check")),
      );
    expect(rows).toHaveLength(0);
  });
});
