// spec-300 issue-7 — auxiliary-file mutation on skill EDIT (add / replace / remove).
// Before this, aux files were create-only; editSkill took only skillMd + capabilities.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../../db/connection.js";
import { memexes } from "../../db/schema.js";
import { makeTestMemex } from "../test-helpers.js";
import { createSkill, editSkill } from "./skills-service.js";
import { reconstructSkillMd } from "./reconstruct-skill-md.js";
import * as storageProvider from "../storage/index.js";

// spec-300 issue-8: a text-only aux-file edit must not require storage to be
// configured — applySkillFileOps resolves the provider lazily, only for real blob ops.
const AC_ISSUE8 = "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-60";

const MD = reconstructSkillMd({
  name: "edit-files-skill",
  description: "Use when: testing aux-file mutation on edit.",
  body: "# Body\n\nText.",
});

let memexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("skl-ef");
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, [memexId])).catch(() => {});
});

describe("editSkill adds, replaces, and removes auxiliary files (issue-7)", () => {
  it("adds a text file, replaces it, then removes it", async () => {
    const created = await createSkill(memexId, { skillMd: MD });
    const ref = created.handle; // editSkill resolves by handle (as the REST route does)
    expect(created.files).toHaveLength(0);

    // ADD — a new text file appears in the TOC at its byte size ("first" = 5 bytes).
    const added = await editSkill(memexId, ref, {
      files: [{ path: "notes/a.md", text: "first" }],
    });
    const addedEntry = added.files.filter((f) => f.path === "notes/a.md");
    expect(addedEntry).toHaveLength(1);
    expect(addedEntry[0].size).toBe(5);

    // REPLACE — same path, new content ("second" = 6 bytes). Still ONE entry
    // (the unique(skillDocId,path) manifest constraint holds), size updated.
    const replaced = await editSkill(memexId, ref, {
      files: [{ path: "notes/a.md", text: "second" }],
    });
    const replacedEntry = replaced.files.filter((f) => f.path === "notes/a.md");
    expect(replacedEntry).toHaveLength(1);
    expect(replacedEntry[0].size).toBe(6);

    // REMOVE — the path drops out of the TOC.
    const removed = await editSkill(memexId, ref, { removeFiles: ["notes/a.md"] });
    expect(removed.files.map((f) => f.path)).not.toContain("notes/a.md");
  });

  it("adds a binary file on edit (bytes go through the storage provider)", async () => {
    const created = await createSkill(memexId, {
      skillMd: reconstructSkillMd({
        name: "edit-binary-skill",
        description: "Use when: testing a binary add on edit.",
        body: "# Body",
      }),
    });
    const edited = await editSkill(memexId, created.handle, {
      files: [
        {
          path: "assets/x.bin",
          contentType: "application/octet-stream",
          bytes: new Uint8Array([9, 8, 7, 6]),
        },
      ],
    });
    const entry = edited.files.filter((f) => f.path === "assets/x.bin");
    expect(entry).toHaveLength(1);
    expect(entry[0].size).toBe(4);
    expect(entry[0].contentType).toBe("application/octet-stream");
  });

  it("rejects an edit that changes nothing (no skillMd / capabilities / files)", async () => {
    const created = await createSkill(memexId, {
      skillMd: reconstructSkillMd({
        name: "edit-noop-skill",
        description: "Use when: testing the empty-edit guard.",
        body: "# Body",
      }),
    });
    await expect(editSkill(memexId, created.handle, {})).rejects.toThrow();
  });
});

describe("editSkill text-only file ops do not require storage config (issue-8)", () => {
  it("a text-only add succeeds even when getStorageProvider() would throw (prod 500 repro)", async () => {
    tagAc(AC_ISSUE8);
    const created = await createSkill(memexId, {
      skillMd: reconstructSkillMd({
        name: "issue8-text-only-edit",
        description: "Use when: reproducing the issue-8 text-only edit 500.",
        body: "# Body",
      }),
    });

    // Simulate production without STORAGE_GCS_BUCKET: getStorageProvider() throws.
    // Before the fix, applySkillFileOps resolved the provider EAGERLY at the top of
    // the function — even for a text-only edit that touches no blob storage — so this
    // exact edit 500'd on prod. The fix resolves the provider lazily, only when a
    // bucket blob is actually written or deleted.
    const spy = vi
      .spyOn(storageProvider, "getStorageProvider")
      .mockImplementation(() => {
        throw new Error("STORAGE_GCS_BUCKET is not configured (simulated prod)");
      });

    try {
      const edited = await editSkill(memexId, created.handle, {
        files: [{ path: "notes/only-text.md", text: "hello", contentType: "text/markdown" }],
      });
      // The text file lands (inline, no storage), and the provider is never resolved.
      expect(edited.files.some((f) => f.path === "notes/only-text.md")).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
