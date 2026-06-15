// End-to-end integration tests for the spec-64 t-1 REST search route.
//
//   GET /api/:namespace/:memex/search?q=&kind=&limit=
//
// These hit a REAL Postgres through the full Hono app + middleware stack
// (memexResolver → publicSessionMiddleware → resolveReadableMemexId →
// searchMemex). The route is a thin REST surface over searchMemex; the search
// core itself is covered by services/memex-search.integration.test.ts. Here we
// pin the HTTP contract: the `{ jumpTo, assigned, content }` envelope, UUID
// stripping, param forwarding, the unknown-tenant 404, the FTS-only fallback,
// draft inclusion, and archived/paused exclusion.
//
// EMBEDDING_DISABLED=1 (hoisted below) forces resolveEmbeddingProvider() to
// return null for the whole file, so every request here runs the FTS-only path
// — deterministic and zero external API calls. ac-11 asserts that path 200s
// with content; the other ACs ride the same FTS arm, which is sufficient since
// the route forwards the same options regardless of provider.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";

vi.hoisted(() => {
  // Force auth-mode session middleware so per-user Bearer tokens are honored
  // (mirrors public-content-read.integration.test.ts), and disable the
  // embedding provider so searchMemex runs FTS-only (ac-11 path).
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET ?? "x".repeat(48);
  process.env.EMBEDDING_DISABLED = "1";
  return undefined;
});

import { db } from "../db/connection.js";
import { app } from "../app.js";
import { documents } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createStandard } from "../services/standards.js";
import { upsertUserByEmail } from "../services/users.js";
import { assign } from "../services/doc-assignees.js";
import { signSessionToken } from "../services/auth-jwt.js";
import { tagAc } from "@memex-ai-ac/vitest";

// spec-64 — full canonical AC refs (…/acs/ac-N), never the bare handle.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-64/acs/ac-${n}`;

interface ContentHit {
  kind: string;
  path: string;
  title: string;
  status: string;
  score: number;
  matchingSections: Array<{ id: string; sectionType: string }>;
  id?: unknown;
  parentDocId?: unknown;
  // spec-285: WHO/WHEN ride through the Omit projection into the wire shape.
  authorName?: string | null;
  lastUpdatedAt?: string | null;
}

interface SearchEnvelope {
  jumpTo: unknown;
  assigned: unknown;
  content: ContentHit[];
}

const createdDocIds: string[] = [];
let memexId: string;
let nsSlug: string;
// Bearer for dev@memex.ai, whom makeTestMemexWithDevAdmin enrols as an
// administrator member of the seeded (private-by-default) memex. We
// authenticate as that member so the read gate grants access.
let memberBearer: string;

// A unique token we can search for deterministically via FTS.
const TOKEN = "spec64searchroutetoken";

// spec-64 t-2 fixtures. A distinctive Spec title-substring (ac-18) that is ALSO
// a unique FTS token in the body, so one query proves the title appears in
// jumpTo AND the body hit appears in content within the same response.
const JUMP_TITLE_TOKEN = "Zorptastic";
// The exact handle of the title-substring Spec (ac-17 exact-handle jump).
let jumpSpecHandle: string;
// A Spec assigned to the dev user, surfaced by `@dev` (ac-19).
const ASSIGNED_TITLE = "Assigned spec for s64 t2";
let assignedSpecHandle: string;

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s64");
  memexId = made.memexId;
  nsSlug = made.slug;

  const devUser = await upsertUserByEmail("dev@memex.ai");
  memberBearer = signSessionToken(devUser.id);

  // A DRAFT spec whose content carries the unique token (ac-13).
  const draftSpec = await createDocDraft(
    memexId,
    "Draft spec for search",
    `Overview mentions ${TOKEN} prominently.`,
    "spec",
  );
  createdDocIds.push(draftSpec.id);

  // A standard carrying the same token in a section (for the kind filter test).
  const std = await createStandard(memexId, {
    title: "Search standard",
    sections: [{ sectionType: "do", content: `Always ${TOKEN} when searching.` }],
  });
  createdDocIds.push(std.id);

  // An ARCHIVED spec carrying the token — must NOT appear (ac-14).
  const archivedSpec = await createDocDraft(
    memexId,
    "Archived spec for search",
    `This archived doc also mentions ${TOKEN}.`,
    "spec",
  );
  createdDocIds.push(archivedSpec.id);
  // createDocDraft already seeds an `overview` section carrying TOKEN, so the
  // archived doc is FTS-matchable on its own — a second `overview` section would
  // collide (sections.ts enforces unique sectionType per doc).
  await db.execute(
    sql`UPDATE documents SET archived_at = now() WHERE id = ${archivedSpec.id}`,
  );

  // spec-64 t-2 (ac-17/ac-18): a Spec whose TITLE carries JUMP_TITLE_TOKEN and
  // whose body (the seeded overview) carries the same token. The title drives
  // the jumpTo title-substring lane; the body drives the content FTS lane — both
  // from one query. We capture its minted spec-N handle for the exact-handle
  // jump test (ac-17).
  const jumpSpec = await createDocDraft(
    memexId,
    `${JUMP_TITLE_TOKEN} jump-to spec`,
    `This spec body also mentions ${JUMP_TITLE_TOKEN} so FTS matches it.`,
    "spec",
  );
  createdDocIds.push(jumpSpec.id);
  jumpSpecHandle = jumpSpec.handle;

  // spec-64 t-2 (ac-19): a Spec assigned to the dev user, surfaced by `@dev`
  // (dev@memex.ai → email local-part "dev"). assign() is the spec-118 service
  // the board uses; assignedBy is the dev user (self-assign).
  const assignedSpec = await createDocDraft(memexId, ASSIGNED_TITLE, "Body.", "spec");
  createdDocIds.push(assignedSpec.id);
  assignedSpecHandle = assignedSpec.handle;
  await assign(memexId, assignedSpec.id, devUser.id, devUser.id);
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db
      .delete(documents)
      .where(inArray(documents.id, createdDocIds))
      .catch(() => {});
  }
});

// The seeded memex is private-by-default (memexes.visibility defaults to
// 'private'), so an anonymous request would 404 at the read gate (std-7). We
// authenticate every request as the dev member (admin of the seeded memex) via
// a signed session token — membership resolves the path memex in
// publicSessionMiddleware, granting the read.
function req(path: string): Promise<Response> {
  const headers = new Headers();
  headers.set("Host", "memex.ai");
  headers.set("Authorization", `Bearer ${memberBearer}`);
  return Promise.resolve(app.request(path, { method: "GET", headers }));
}

const searchUrl = (params: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString();
  return `/api/${nsSlug}/main/search?${qs}`;
};

describe("spec-64 t-1 — REST search envelope (ac-6)", () => {
  it("responds 200 with a { jumpTo, assigned, content } body", async () => {
    tagAc(AC(6));
    const res = await req(searchUrl({ q: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    // Envelope shape: exactly the three lanes, each an array.
    expect(Array.isArray(body.jumpTo)).toBe(true);
    expect(Array.isArray(body.assigned)).toBe(true);
    expect(Array.isArray(body.content)).toBe(true);
    // jumpTo + assigned are spec-64 t-2's lanes — empty in t-1.
    expect(body.jumpTo).toEqual([]);
    expect(body.assigned).toEqual([]);
    // content has at least the draft spec hit for the unique token.
    expect(body.content.length).toBeGreaterThan(0);
  });
});

describe("spec-64 t-1 — content hit shape + param forwarding (ac-7)", () => {
  it("content entries expose the public MemexSearchHit fields with NO UUIDs", async () => {
    tagAc(AC(7));
    const res = await req(searchUrl({ q: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    expect(body.content.length).toBeGreaterThan(0);

    for (const hit of body.content) {
      // Public fields present.
      expect(hit).toHaveProperty("kind");
      expect(hit).toHaveProperty("path");
      expect(hit).toHaveProperty("title");
      expect(hit).toHaveProperty("status");
      expect(hit).toHaveProperty("score");
      expect(hit).toHaveProperty("matchingSections");
      // Internal doc UUIDs stripped (ac-7): the route drops `id` +
      // `parentDocId`. (matchingSections still carry their own section ids —
      // those are part of MemexSearchHit and out of scope for ac-7's strip,
      // which names exactly `id` and `parentDocId`.)
      expect(hit.id).toBeUndefined();
      expect(hit.parentDocId).toBeUndefined();
    }
  });

  it("forwards `kind` to searchMemex (kind=standard returns only standards)", async () => {
    tagAc(AC(7));
    const res = await req(searchUrl({ q: TOKEN, kind: "standard" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    expect(body.content.length).toBeGreaterThan(0);
    for (const hit of body.content) {
      expect(hit.kind).toBe("standard");
    }
  });

  it("forwards `limit` to searchMemex (limit caps content length)", async () => {
    tagAc(AC(7));
    const res = await req(searchUrl({ q: TOKEN, limit: "1" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    expect(body.content.length).toBeLessThanOrEqual(1);
  });

  it("an unknown namespace/memex returns 404", async () => {
    tagAc(AC(7));
    const res = await req(
      `/api/no-such-namespace-${Date.now()}/nope/search?q=${TOKEN}`,
    );
    expect(res.status).toBe(404);
  });
});

describe("spec-64 t-1 — FTS-only fallback when vector disabled (ac-11)", () => {
  it("responds 200 with FTS content even with no embedding provider", async () => {
    tagAc(AC(11));
    // EMBEDDING_DISABLED=1 is set for this whole file, so searchMemex resolved a
    // null provider and ran FTS-only. The route must still 200 with content.
    const res = await req(searchUrl({ q: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    expect(body.content.length).toBeGreaterThan(0);
  });
});

describe("spec-64 t-1 — draft Specs are returned (ac-13)", () => {
  it("a draft-status Spec matching the query appears in content", async () => {
    tagAc(AC(13));
    const res = await req(searchUrl({ q: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    const draftHit = body.content.find(
      (h) => h.kind === "spec" && h.status === "draft",
    );
    expect(draftHit).toBeDefined();
  });
});

describe("spec-64 t-1 — archived/paused docs excluded (ac-14)", () => {
  it("an archived spec matching the query does NOT appear", async () => {
    tagAc(AC(14));
    const res = await req(searchUrl({ q: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    // The archived spec's title is unique; it must not surface.
    const archivedHit = body.content.find(
      (h) => h.title === "Archived spec for search",
    );
    expect(archivedHit).toBeUndefined();
  });
});

describe("spec-64 t-2 — exact handle surfaces in jumpTo (ac-17)", () => {
  it("typing a spec-N handle returns that exact entity in jumpTo", async () => {
    tagAc(AC(17));
    const res = await req(searchUrl({ q: jumpSpecHandle }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    const jumpTo = body.jumpTo as ContentHit[];
    expect(Array.isArray(jumpTo)).toBe(true);
    // The exact-handle hit is present in jumpTo (not only in content).
    const hit = jumpTo.find((h) => h.path.endsWith(`/${jumpSpecHandle}`));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("spec");
    // Public shape: no internal UUIDs leak through the jump lane either (ac-7).
    expect(hit?.id).toBeUndefined();
    expect(hit?.parentDocId).toBeUndefined();
  });
});

describe("spec-64 t-2 — title-substring in jumpTo + FTS hit in content (ac-18)", () => {
  it("free text returns a Spec title match in jumpTo AND a content hit in one response", async () => {
    tagAc(AC(18));
    const res = await req(searchUrl({ q: JUMP_TITLE_TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;

    // jumpTo carries the Spec whose TITLE contains the query (case-insensitive
    // substring), scoped to docType='spec'.
    const jumpTo = body.jumpTo as ContentHit[];
    const jumpHit = jumpTo.find((h) => h.title.includes(JUMP_TITLE_TOKEN));
    expect(jumpHit).toBeDefined();
    expect(jumpHit?.kind).toBe("spec");

    // content carries the same Spec via the FTS body match — same response.
    const contentHit = body.content.find((h) =>
      h.title.includes(JUMP_TITLE_TOKEN),
    );
    expect(contentHit).toBeDefined();
  });

  it("title-substring is case-insensitive", async () => {
    tagAc(AC(18));
    const res = await req(searchUrl({ q: JUMP_TITLE_TOKEN.toLowerCase() }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    const jumpTo = body.jumpTo as ContentHit[];
    const jumpHit = jumpTo.find((h) => h.title.includes(JUMP_TITLE_TOKEN));
    expect(jumpHit).toBeDefined();
  });
});

describe("spec-64 t-2 — @name returns that member's assigned Specs (ac-19)", () => {
  it("typing @dev returns the Spec assigned to dev@memex.ai in assigned", async () => {
    tagAc(AC(19));
    // dev@memex.ai has no display name, so @dev matches the email local-part.
    const res = await req(searchUrl({ q: "@dev" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    const assigned = body.assigned as ContentHit[];
    expect(Array.isArray(assigned)).toBe(true);
    const hit = assigned.find((h) => h.path.endsWith(`/${assignedSpecHandle}`));
    expect(hit).toBeDefined();
    expect(hit?.kind).toBe("spec");
    // Public shape preserved on the assigned lane too (ac-7).
    expect(hit?.id).toBeUndefined();
    expect(hit?.parentDocId).toBeUndefined();
  });

  it("a non-@ query leaves assigned empty", async () => {
    tagAc(AC(19));
    const res = await req(searchUrl({ q: JUMP_TITLE_TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    expect(body.assigned).toEqual([]);
  });

  it("@<nobody> resolves to no members and returns empty assigned", async () => {
    tagAc(AC(19));
    const res = await req(searchUrl({ q: "@nosuchpersonzzz" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;
    expect(body.assigned).toEqual([]);
  });
});

// spec-191: full canonical AC ref for the number-jump follow-on.
const AC191 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-191/acs/ac-${n}`;

describe("spec-191 — number jump is additive to jumpTo; content tier unchanged (ac-6)", () => {
  it("a numeric query surfaces the number jump in jumpTo while the content FTS lane is untouched", async () => {
    tagAc(AC191(6));
    // A dedicated Spec whose body carries no digit token, so the content FTS lane
    // finds nothing for a bare number — proving the number jump is purely additive
    // to the jumpTo lane and never altered searchMemex (FTS + pgvector + RRF).
    const numSpec = await createDocDraft(
      memexId,
      "Number jump route target",
      "Body without any digit token.",
      "spec",
    );
    createdDocIds.push(numSpec.id);
    const num = Number(numSpec.handle.split("-")[1]);

    const res = await req(searchUrl({ q: String(num) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope;

    // The number jump reaches the human ⌘K palette through the REST route.
    const jumpTo = body.jumpTo as ContentHit[];
    const jumpHit = jumpTo.find((h) => h.path.endsWith(`/specs/${numSpec.handle}`));
    expect(jumpHit).toBeDefined();
    expect(jumpHit?.kind).toBe("spec");
    // Public shape preserved (no UUIDs leak through the jump lane).
    expect(jumpHit?.id).toBeUndefined();

    // The content tier is unchanged: a bare digit has no FTS lexeme match against
    // the seeded text, so the Spec does NOT appear as a content hit — the number
    // jump never touched the semantic core.
    const inContent = body.content.find((h) =>
      h.path.endsWith(`/specs/${numSpec.handle}`),
    );
    expect(inContent).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// spec-285 ac-3: the WHO/WHEN metadata added to MemexSearchHit rides through
// the REST route's `SearchContentHit = Omit<MemexSearchHit, "id"|"parentDocId">`
// projection with NO route change — every content hit exposes `authorName` and
// `lastUpdatedAt`, and a resolvable created_by surfaces a real name + ISO date.
// ─────────────────────────────────────────────────────────────────────────
const SPEC285_AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-285/acs/ac-${n}`;

describe("spec-285 — REST search inherits author + timestamp (ac-3)", () => {
  it("every content hit exposes authorName + lastUpdatedAt, populated from created_by", async () => {
    tagAc(SPEC285_AC(3));
    const devUser = await upsertUserByEmail("dev@memex.ai");
    const expectedDisplay = devUser.name?.trim() || devUser.email;

    // Stamp a resolvable author on the token-bearing docs so the resolution path
    // (created_by_user_id → users.name ?? email) produces a concrete value.
    await db
      .update(documents)
      .set({ createdByUserId: devUser.id })
      .where(inArray(documents.id, createdDocIds));

    const res = await req(searchUrl({ q: TOKEN }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchEnvelope & {
      content: Array<ContentHit & { authorName?: unknown; lastUpdatedAt?: unknown }>;
    };
    expect(body.content.length).toBeGreaterThan(0);

    for (const hit of body.content) {
      // Inheritance through Omit: the new fields are present on the wire shape.
      expect(hit).toHaveProperty("authorName");
      expect(hit).toHaveProperty("lastUpdatedAt");
    }

    // At least one hit resolved the stamped author to a concrete display + ISO date.
    const populated = body.content.find((h) => h.authorName === expectedDisplay);
    expect(populated).toBeDefined();
    expect(typeof populated!.lastUpdatedAt).toBe("string");
    expect(() => new Date(populated!.lastUpdatedAt as string).toISOString()).not.toThrow();
  });
});
