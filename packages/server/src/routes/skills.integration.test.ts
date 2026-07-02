import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";

// Force dev-mode auth so app.request() authenticates as dev@memex.ai without a
// minted JWT (same shape as qa-reports.integration.test.ts).
vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = "";
  return undefined;
});

import { db } from "../db/connection.js";
import { memexes, namespaces } from "../db/schema.js";
import { app } from "../app.js";
import { makeTestMemex, makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { reconstructSkillMd } from "../services/skills/reconstruct-skill-md.js";

const AC_37 = "mindset-prod/memex-building-itself/specs/spec-300/acs/ac-37";

const SKILL_MD = reconstructSkillMd({
  name: "route-skill",
  description: "Created over REST. Use when: exercising the route.",
  body: "# Body\n\nText.",
});

let memberPath: string; // dev is administrator (write) here
let nonMemberPath: string; // dev is NOT a member here
const memexIds: string[] = [];

function withApexHost(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), Host: "memex.ai" } };
}

beforeAll(async () => {
  const member = await makeTestMemexWithDevAdmin("skl-route-m");
  memberPath = `/api/${member.slug}/main`;
  memexIds.push(member.memexId);

  const outsiderId = await makeTestMemex("skl-route-x");
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

describe("POST /api/<ns>/<mx>/skills — write access (dec-15, std-7)", () => {
  it("a member with write access can create a skill (201)", async () => {
    tagAc(AC_37);

    const res = await app.request(
      `${memberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillMd: SKILL_MD }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { handle: string; name: string };
    expect(body.name).toBe("route-skill");
    expect(body.handle).toMatch(/^skill-\d+$/);

    // And the created skill is then listable + gettable over the same surface.
    const list = await app.request(`${memberPath}/skills`, withApexHost());
    expect(list.status).toBe(200);
    const skills = (await list.json()) as { handle: string }[];
    expect(skills.some((s) => s.handle === body.handle)).toBe(true);
  });

  it("a non-member is refused (404, not 403 — std-7)", async () => {
    tagAc(AC_37);

    const res = await app.request(
      `${nonMemberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillMd: SKILL_MD }),
      }),
    );
    // The strict session membership check 404s a non-member on a write route
    // before the handler runs (indistinguishable from a non-existent memex).
    expect(res.status).toBe(404);
  });
});

describe("GET /skills/usage + /skills/usage/by-spec — hot/cold + inverse (dec-21)", () => {
  it("meters a body fetch and surfaces it in the report + the per-Spec inverse view", async () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-300/acs/ac-18");

    const specRef = `mindset-prod/memex-building-itself/specs/spec-300#rest-${Date.now()}`;
    const create = await app.request(
      `${memberPath}/skills`,
      withApexHost({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillMd: reconstructSkillMd({
            name: "usage-route-skill",
            description: "Metered over REST. Use when: exercising /usage.",
            body: "# Body\n\nText.",
          }),
        }),
      }),
    );
    expect(create.status).toBe(201);
    const { handle } = (await create.json()) as { handle: string };

    // A body fetch (with the working-Spec ref) records a use over the rest_ui channel.
    const get = await app.request(
      `${memberPath}/skills/${handle}?working_spec_ref=${encodeURIComponent(specRef)}`,
      withApexHost(),
    );
    expect(get.status).toBe(200);

    // The static `/usage` route resolves to the report, NOT the `/:handle` handler.
    const report = await app.request(`${memberPath}/skills/usage`, withApexHost());
    expect(report.status).toBe(200);
    const rows = (await report.json()) as { handle: string; useCount: number }[];
    const mine = rows.find((r) => r.handle === handle);
    expect(mine?.useCount).toBeGreaterThanOrEqual(1);

    // The inverse view lists the skill pulled against this Spec.
    const inverse = await app.request(
      `${memberPath}/skills/usage/by-spec?spec=${encodeURIComponent(specRef)}`,
      withApexHost(),
    );
    expect(inverse.status).toBe(200);
    const pulled = (await inverse.json()) as { handle: string }[];
    expect(pulled.some((s) => s.handle === handle)).toBe(true);

    // Missing `spec` is a 400.
    const bad = await app.request(`${memberPath}/skills/usage/by-spec`, withApexHost());
    expect(bad.status).toBe(400);
  });
});
