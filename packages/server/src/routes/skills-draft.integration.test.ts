// spec-300 t-15 Increment 1 (ac-49, closes ac-21) — the POST /skills/draft route
// the "Describe it" tab calls. The route delegates to draftSkillFromDescription
// (LLM-backed via getAnthropicClient, std-30), so we stub THAT here and assert the
// route's own contract: write-access gate (dec-15 / std-7), input validation, and
// the JSON shape it hands back for the create flow to persist. The draft service's
// own describe→draft→validate behaviour is unit-tested in draft-skill.test.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Dev-mode auth (no minted JWT) — same shape as skills.integration.test.ts.
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

const draftMock = vi.fn();
vi.mock("../services/skills/draft-skill.js", () => ({
  draftSkillFromDescription: (...a: unknown[]) => draftMock(...a),
}));

import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex, makeTestMemexWithDevAdmin } from "../services/test-helpers.js";

const AC_49 = "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-49";

const DRAFT = {
  skillMd:
    "---\nname: drafted-skill\ndescription: Drafted from a plain-language description.\n---\n# Drafted skill\n\nSteps.\n",
  name: "drafted-skill",
  description: "Drafted from a plain-language description.",
  body: "# Drafted skill\n\nSteps.\n",
};

let memberPath: string; // dev is administrator (write) here
let nonMemberPath: string; // dev is NOT a member here
const memexIds: string[] = [];

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

beforeAll(async () => {
  const member = await makeTestMemexWithDevAdmin("skl-draft-m");
  memberPath = `/api/${member.slug}/main`;
  memexIds.push(member.memexId);

  const outsiderId = await makeTestMemex("skl-draft-x");
  memexIds.push(outsiderId);
  const [ns] = await db
    .select({ slug: namespaces.slug })
    .from(namespaces)
    .innerJoin(memexes, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, outsiderId))
    .limit(1);
  nonMemberPath = `/api/${ns!.slug}/main`;
});

afterAll(async () => {
  await db.delete(memexes).where(inArray(memexes.id, memexIds)).catch(() => {});
});

describe("POST /api/<ns>/<mx>/skills/draft (spec-300 t-15 Increment 1)", () => {
  it("drafts a validated SKILL.md from a description for a write member (ac-49)", async () => {
    tagAc(AC_49);
    draftMock.mockResolvedValueOnce(DRAFT);

    const res = await app.request(
      `${memberPath}/skills/draft`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "A skill that reviews a PR for missing tests." }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof DRAFT;
    expect(body.skillMd).toBe(DRAFT.skillMd);
    expect(body.name).toBe("drafted-skill");
    // The description reached the draft service verbatim.
    expect(draftMock).toHaveBeenCalledTimes(1);
    expect(draftMock.mock.calls[0][0]).toContain("reviews a PR");
  });

  it("rejects a blank description with a 400 (ac-49)", async () => {
    tagAc(AC_49);
    draftMock.mockClear();

    const res = await app.request(
      `${memberPath}/skills/draft`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "   " }),
      }),
    );

    expect(res.status).toBe(400);
    // Validation fails before the LLM is ever consulted.
    expect(draftMock).not.toHaveBeenCalled();
  });

  it("refuses a non-member as not-found (404, std-7) — no draft attempted (ac-49)", async () => {
    tagAc(AC_49);
    draftMock.mockClear();

    const res = await app.request(
      `${nonMemberPath}/skills/draft`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: "anything" }),
      }),
    );

    expect(res.status).toBe(404);
    expect(draftMock).not.toHaveBeenCalled();
  });
});
