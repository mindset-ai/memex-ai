// spec-300 issue-5 + issue-6 — the from-disk / coding-agent import surface:
//   issue-5: a checkout HOOK KEY authorizes the skills WRITE routes (not just a
//            web-session JWT), so `memex-ai skill push` / a coding agent can create.
//   issue-6: POST /skills also accepts multipart/form-data, so binary aux bytes
//            upload as raw file parts (no base64-in-JSON).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";

// Dev-mode auth (no minted JWT) — same shape as skills.integration.test.ts.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { memexes } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { mintHookKey } from "../services/hook-keys.js";
import { reconstructSkillMd } from "../services/skills/reconstruct-skill-md.js";

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}
const md = (name: string) =>
  reconstructSkillMd({
    name,
    description: `Created in a test. Use when: exercising ${name}.`,
    body: "# Body\n\nText.",
  });

let memberPath: string;
const memexIds: string[] = [];
let memberKey: string; // hook key of the dev user (a member/admin)
let outsiderKey: string; // hook key of a non-member

beforeAll(async () => {
  const m = await makeTestMemexWithDevAdmin("skl-imp");
  memberPath = `/api/${m.slug}/main`;
  memexIds.push(m.memexId);

  const dev = await upsertUserByEmail("dev@memex.ai");
  memberKey = (await mintHookKey("test member key", dev.id)).raw;

  const outsider = await upsertUserByEmail("skl-imp-outsider@example.com");
  outsiderKey = (await mintHookKey("test outsider key", outsider.id)).raw;
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
});

describe("skills write routes accept the checkout hook key (issue-5)", () => {
  it("a member's hook key can create a skill (201)", async () => {
    const res = await app.request(
      `${memberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${memberKey}` },
        body: JSON.stringify({ skillMd: md("hook-key-create") }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("hook-key-create");
  });

  it("a non-member's hook key is refused as not-found (404, std-7)", async () => {
    const res = await app.request(
      `${memberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${outsiderKey}` },
        body: JSON.stringify({ skillMd: md("should-not-create") }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("a garbage hook key is refused as not-found (404)", async () => {
    const res = await app.request(
      `${memberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer mxh_not_a_real_key" },
        body: JSON.stringify({ skillMd: md("nope") }),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /skills accepts multipart/form-data with binary parts (issue-6)", () => {
  it("creates a skill from a multipart body carrying a binary file", async () => {
    const form = new FormData();
    form.set("skillMd", md("multipart-create"));
    form.append(
      "files",
      new File([new Uint8Array([1, 2, 3, 4, 5])], "assets/blob.bin", {
        type: "application/octet-stream",
      }),
    );

    // No explicit content-type header — the Request infers multipart + boundary
    // from the FormData body. Dev-auth (member) authorizes the write.
    const res = await app.request(`${memberPath}/skills`, withApexHost({ method: "POST", body: form }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; files: { path: string; size: number }[] };
    expect(body.name).toBe("multipart-create");
    const blob = body.files.find((f) => f.path === "assets/blob.bin");
    expect(blob).toBeDefined();
    expect(blob?.size).toBe(5);
  });
});
