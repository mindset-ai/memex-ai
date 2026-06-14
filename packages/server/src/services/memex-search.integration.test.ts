// Integration tests for searchMemex (b-34 T-3 — generalised from the
// standards-only search shipped in doc-8 t-6). Exercises:
//   - handle short-circuit across all docTypes (UUIDs deliberately not
//     accepted per b-36 D-5/D-8 — a UUID-shape query falls through to FTS)
//   - FTS path with `kind` filter
//   - vector path with deterministic FakeEmbeddingProvider
//   - RRF merge across FTS + vector
//   - Decision arm hits + path shape
//   - Archived / paused exclusion (default + opt-in)
//   - Memex scoping (no cross-tenant leakage)
//   - Result formatter: zero UUIDs in output (b-36 D-7)

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { inArray, sql, eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createStandard } from "./standards.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { createIssue, type IssueType } from "./issues.js";
import { upsertUserByEmail } from "./users.js";
import {
  embedAndStoreDoc,
  embedAndStoreDecision,
  embedAndStoreIssue,
} from "./memex-embeddings.js";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  searchMemex,
  resolveJumpTo,
  formatSearchResults,
  type MemexSearchHit,
} from "./memex-search.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { makeTestMemex } from "./test-helpers.js";

function makeFakeProvider(name = "fake-search-1536"): EmbeddingProvider & {
  callCount: number;
} {
  const provider = {
    name,
    dim: 1536,
    maxBatchSize: 16,
    callCount: 0,
    async embed(texts: string[]): Promise<number[][]> {
      provider.callCount += 1;
      return texts.map((t) => {
        // Encode a coarse-grained "topic" into the vector so similarity is
        // meaningful: we boost specific dimensions for keywords. That way the
        // query "caching" returns a vector close to a section that mentions
        // "cache" / "caching".
        const baseSeed = Array.from(t).reduce(
          (acc, ch) => acc + ch.charCodeAt(0),
          0,
        );
        const vec = Array.from({ length: 1536 }, (_, i) => ((baseSeed + i) % 100) / 100);
        const lower = t.toLowerCase();
        const topics = [
          { word: "cach", dim: 0 },
          { word: "retr", dim: 1 },
          { word: "log", dim: 2 },
          { word: "phase", dim: 3 },
          { word: "embed", dim: 4 },
          { word: "search", dim: 5 },
        ];
        for (const topic of topics) {
          if (lower.includes(topic.word)) {
            vec[topic.dim] = 1;
          }
        }
        return vec;
      });
    },
  };
  return provider;
}

// spec-64 t-7 / ac-21: a provider that places content in two ORTHOGONAL regions
// of vector space so cosine distances are deterministic and straddle the
// relevance floor. makeFakeProvider's hashed ramps sit at near-zero distance
// for everything (its own tests note unrelated content produces "near-equal
// distances"), so it can't exercise a floor. Here:
//   - any text containing "floornearmatch" → unit vector on dim 0
//   - everything else                      → unit vector on dim 1
// A query containing "floornearmatch" embeds onto dim 0, so cosine distance to
// a NEAR section (dim 0) is 0.0 and to a FAR section (dim 1) is 1.0 (orthogonal
// → well beyond any sane floor).
function makeOrthogonalProvider(
  name = "fake-floor-1536",
): EmbeddingProvider {
  const DIM = 1536;
  return {
    name,
    dim: DIM,
    maxBatchSize: 16,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const v = new Array(DIM).fill(0);
        v[t.toLowerCase().includes("floornearmatch") ? 0 : 1] = 1;
        return v;
      });
    },
  };
}

// spec-112 t-4: full canonical AC ref (…/acs/ac-N), never the bare handle.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

// spec-64 t-7: this Spec's AC refs (the relevance-floor bug is i-1 → ac-21).
const SPEC64_AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-64/acs/ac-${n}`;

const createdDocIds: string[] = [];
let memexId: string;
let otherMemexId: string;

beforeAll(async () => {
  memexId = await makeTestMemex("srch");
  otherMemexId = await makeTestMemex("srch2");
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

async function seedStandard(
  acc: string,
  title: string,
  sections: Array<{ sectionType: string; content: string }>,
  provider: EmbeddingProvider,
) {
  const std = await createStandard(acc, { title, sections });
  createdDocIds.push(std.id);
  await embedAndStoreDoc(std.id, { provider });
  return std;
}

async function seedSpec(
  acc: string,
  title: string,
  overview: string,
  body: Array<{ sectionType: string; content: string }>,
  provider: EmbeddingProvider,
) {
  const spec = await createDocDraft(acc, title, overview, "spec");
  createdDocIds.push(spec.id);
  for (const sec of body) {
    await addSection(acc, spec.id, sec.sectionType, sec.content);
  }
  await embedAndStoreDoc(spec.id, { provider });
  return spec;
}

async function seedDecision(
  acc: string,
  parentSpec: { id: string },
  title: string,
  context: string,
  resolution: string | null,
  provider: EmbeddingProvider,
) {
  const dec = await createDecision(acc, parentSpec.id, title, context);
  if (resolution) {
    await resolveDecision(acc, dec.id, resolution);
  }
  await embedAndStoreDecision(dec.id, { provider });
  return dec;
}

async function seedIssue(
  acc: string,
  parentSpec: { id: string },
  title: string,
  body: string,
  type: IssueType,
  provider: EmbeddingProvider,
) {
  const issue = await createIssue({
    memexId: acc,
    docId: parentSpec.id,
    title,
    body,
    type,
  });
  // createIssue already fires a best-effort background embed, but we embed
  // synchronously here so the vector arm is deterministic for the test.
  await embedAndStoreIssue(issue.id, { provider });
  return issue;
}

describe("searchMemex — handle short-circuit", () => {
  it("returns the doc when query is its handle (standard)", async () => {
    const provider = makeFakeProvider();
    const std = await seedStandard(
      memexId,
      "Lookup by handle",
      [{ sectionType: "do", content: "Anything." }],
      provider,
    );
    const hits = await searchMemex(memexId, std.handle, { provider });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(std.id);
    expect(hits[0].strategies).toEqual(["handle"]);
    expect(hits[0].kind).toBe("standard");
    expect(hits[0].path).toContain(`/standards/${std.handle}`);
  });

  it("returns the doc when query is its handle (spec — spec-N path)", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Find me by handle",
      "Overview here.",
      [],
      provider,
    );
    const hits = await searchMemex(memexId, spec.handle, { provider });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("spec");
    expect(hits[0].path).toContain(`/specs/${spec.handle}`);
  });

  it("does NOT short-circuit when query is a raw UUID (b-36 D-5/D-8)", async () => {
    // UUIDs are not accepted at the MCP boundary; a UUID-shape query falls
    // through to FTS/vector. The doc's own UUID won't match its text content,
    // so we expect no `handle`-method hit for that doc.
    const provider = makeFakeProvider();
    const std = await seedStandard(
      memexId,
      "Lookup by UUID is not a thing",
      [{ sectionType: "do", content: "Anything." }],
      provider,
    );
    const hits = await searchMemex(memexId, std.id, {
      provider,
      disableVector: true,
    });
    for (const h of hits) {
      expect(h.strategies).not.toContain("handle");
    }
    // And no hit should have the UUID-input doc as a handle match.
    const handleHit = hits.find(
      (h) => h.id === std.id && h.strategies.includes("handle"),
    );
    expect(handleHit).toBeUndefined();
  });

  it("falls back to fuzzy search when the handle doesn't exist", async () => {
    const provider = makeFakeProvider();
    await seedStandard(
      memexId,
      "Cache writes through",
      [{ sectionType: "do", content: "Always cache writes through to disk." }],
      provider,
    );
    const hits = await searchMemex(memexId, "std-99999 caching", {
      provider,
      disableVector: true,
    });
    for (const h of hits) {
      expect(h.strategies).not.toContain("handle");
    }
  });
});

describe("searchMemex — kind filter", () => {
  it("kind='standard' restricts results to standards", async () => {
    const provider = makeFakeProvider();
    const std = await seedStandard(
      memexId,
      "Phase rules",
      [{ sectionType: "do", content: "Phase rules for build." }],
      provider,
    );
    await seedSpec(
      memexId,
      "Phase spec",
      "Phase implementation details.",
      [],
      provider,
    );

    const hits = await searchMemex(memexId, "phase", { provider, kind: "standard" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.kind).toBe("standard");
    }
    expect(hits.find((h) => h.id === std.id)).toBeDefined();
  });

  it("kind='spec' restricts results to specs", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Search-spec title",
      "Search across the Memex.",
      [],
      provider,
    );
    await seedStandard(
      memexId,
      "Search standard",
      [{ sectionType: "do", content: "Search content." }],
      provider,
    );

    const hits = await searchMemex(memexId, "search", { provider, kind: "spec" });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.kind).toBe("spec");
    }
    expect(hits.find((h) => h.id === spec.id)).toBeDefined();
  });

  it("kind omitted returns mixed kinds in one result set", async () => {
    const provider = makeFakeProvider();
    await seedStandard(
      memexId,
      "Logging cache rules",
      [{ sectionType: "do", content: "Cache log levels." }],
      provider,
    );
    const spec = await seedSpec(
      memexId,
      "Logging cache spec",
      "Spec about cache log.",
      [],
      provider,
    );
    await seedDecision(
      memexId,
      spec,
      "Cache log approach",
      "Decide how cache logs.",
      "Use rotating files.",
      provider,
    );

    const hits = await searchMemex(memexId, "cache log", { provider });
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });
});

describe("searchMemex — decision arm", () => {
  it("decision hit has the full canonical path with /decisions/dec-N", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Decision-host spec",
      "Hosts decisions.",
      [],
      provider,
    );
    const dec = await seedDecision(
      memexId,
      spec,
      "Embed retr-style approach",
      "We need a retr-style decision.",
      "Resolved: use retr-style exponential backoff.",
      provider,
    );

    const hits = await searchMemex(memexId, "retr-style", { provider, kind: "decision" });
    const found = hits.find((h) => h.id === dec.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe("decision");
    expect(found!.path).toMatch(/\/specs\/[^/]+\/decisions\/dec-\d+$/);
    expect(found!.decisionSnippet).toBeDefined();
  });

  it("decision FTS matches on title + context + resolution combined", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Multi-field decision spec",
      "Body.",
      [],
      provider,
    );
    const dec = await seedDecision(
      memexId,
      spec,
      "Unrelated title",
      "Context mentions phaseboundaryxyzunique.",
      null,
      provider,
    );

    const hits = await searchMemex(memexId, "phaseboundaryxyzunique", {
      provider,
      kind: "decision",
      disableVector: true,
    });
    expect(hits.find((h) => h.id === dec.id)).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// spec-112 t-4: cross-spec search — Issues ride the SAME RRF FTS+vector path
// as decisions (ac-13). searchMemex accepts kind:'issue', returns issue hits
// merged across FTS+vector, and surfaces issues in unfiltered search too.
// ─────────────────────────────────────────────────────────────────────────

describe("searchMemex — issue arm (spec-112 t-4)", () => {
  it("kind='issue' returns the issue, RRF-merged across FTS + vector", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Issue-host spec",
      "Hosts issues.",
      [],
      provider,
    );
    // "search" is one of the fake provider's encoded topics, so the vector arm
    // ALSO scores this issue highly — exercising the FTS+vector RRF merge.
    const issue = await seedIssue(
      memexId,
      spec,
      "Search box returns stale results",
      "The cross-spec search index lags behind writes.",
      "bug",
      provider,
    );

    const hits = await searchMemex(memexId, "search", { provider, kind: "issue" });
    const found = hits.find((h) => h.id === issue.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe("issue");
    // Both arms surfaced it → strategies carries fts AND vector (RRF merge).
    expect(found!.strategies).toContain("fts");
    expect(found!.strategies).toContain("vector");
    // Canonical cross-spec ref: …/specs/<handle>/issues/issue-N.
    expect(found!.path).toMatch(/\/specs\/[^/]+\/issues\/issue-\d+$/);
    expect(found!.issueSnippet).toBeDefined();
    expect(found!.issueType).toBe("bug");
    // kind filter is honoured — nothing but issues comes back.
    for (const h of hits) {
      expect(h.kind).toBe("issue");
    }
    tagAc(AC(13));
  });

  it("issue FTS matches on title + body combined", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Issue multi-field spec",
      "Body.",
      [],
      provider,
    );
    const issue = await seedIssue(
      memexId,
      spec,
      "Unrelated title",
      "Body mentions issuebodyuniquetokenx and nothing else notable.",
      "todo",
      provider,
    );

    const hits = await searchMemex(memexId, "issuebodyuniquetokenx", {
      provider,
      kind: "issue",
      disableVector: true,
    });
    expect(hits.find((h) => h.id === issue.id)).toBeDefined();
    tagAc(AC(13));
  });

  it("an issue registered on a Spec surfaces in UNFILTERED search_memex scoped to the Memex", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Unfiltered-search host spec",
      "Body.",
      [],
      provider,
    );
    const issue = await seedIssue(
      memexId,
      spec,
      "Token issueunfiltereduniquex regression",
      "An issue raised on one Spec, found via Memex-scoped search.",
      "bug",
      provider,
    );

    // No `kind` filter — issues must appear alongside specs/standards/decisions.
    const hits = await searchMemex(memexId, "issueunfiltereduniquex", {
      provider,
      disableVector: true,
    });
    const found = hits.find((h) => h.id === issue.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe("issue");
    tagAc(AC(13));
  });

  it("issue hits do not leak across memexes (Memex-scoped)", async () => {
    const provider = makeFakeProvider();
    const otherSpec = await seedSpec(
      otherMemexId,
      "Other-tenant issue host",
      "Body.",
      [],
      provider,
    );
    const otherIssue = await seedIssue(
      otherMemexId,
      otherSpec,
      "secretissuecrosstenanttokenx leak",
      "This issue belongs to a different Memex and must not surface.",
      "bug",
      provider,
    );

    const hits = await searchMemex(memexId, "secretissuecrosstenanttokenx", {
      provider,
      disableVector: true,
    });
    expect(hits.find((h) => h.id === otherIssue.id)).toBeUndefined();
    tagAc(AC(13));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// spec-64 t-7 / ac-21: the semantic "In content" tier must have a relevance
// floor. Before the fix, runSectionVector (and the decision/issue vector arms)
// ordered by cosine distance with NO distance ceiling and a LIMIT 50, so a
// low-signal query (e.g. a person's name with no lexical match) returned its
// nearest neighbours however far away they were — unrelated sections with the
// query terms nowhere in them (the bug Ryan hit searching "Ryan Soosayraj").
// ─────────────────────────────────────────────────────────────────────────

describe("searchMemex — semantic relevance floor (spec-64 t-7 / ac-21)", () => {
  it("drops vector hits beyond the cosine-distance floor while keeping near ones", async () => {
    const provider = makeOrthogonalProvider();
    // NEAR: shares the query lexeme AND embeds onto the query's axis (dist 0).
    const near = await seedSpec(
      memexId,
      "Floornearmatch relevant spec",
      "This overview contains floornearmatch so it is genuinely relevant.",
      [],
      provider,
    );
    // FAR: no shared lexeme, embeds onto the orthogonal axis (dist 1.0). FTS
    // can't rescue it — it shares no token with the query — so pre-fix it came
    // back PURELY from the unbounded vector arm. That is the bug.
    const far = await seedSpec(
      memexId,
      "Totally unrelated spec",
      "Nothing in here is about the query; an entirely different topic.",
      [],
      provider,
    );

    const hits = await searchMemex(memexId, "floornearmatch", { provider });
    const ids = hits.map((h) => h.id);
    // The far/unrelated section is filtered out by the relevance floor...
    expect(ids).not.toContain(far.id);
    // ...while the genuinely relevant one still surfaces.
    expect(ids).toContain(near.id);
    tagAc(SPEC64_AC(21));
  });

  it("an explicit maxVectorDistance overrides the default floor", async () => {
    const provider = makeOrthogonalProvider("fake-floor-override-1536");
    const far = await seedSpec(
      memexId,
      "Override unrelated spec",
      "Different topic again; orthogonal to the query vector.",
      [],
      provider,
    );

    // A floor of 2.0 admits everything (max cosine distance is 2.0), so the
    // orthogonal far hit (dist 1.0) is allowed back in — proving the threshold
    // is what gates it, not some unrelated filter.
    const lenient = await searchMemex(memexId, "floornearmatch", {
      provider,
      maxVectorDistance: 2.0,
    });
    expect(lenient.map((h) => h.id)).toContain(far.id);

    // The default (tight) floor drops it again.
    const strict = await searchMemex(memexId, "floornearmatch", { provider });
    expect(strict.map((h) => h.id)).not.toContain(far.id);
    tagAc(SPEC64_AC(21));
  });
});

describe("formatSearchResults — issue hit rendering (spec-112 t-4)", () => {
  it("renders an issue hit with its cross-spec ref and bug/todo type", () => {
    const hits: MemexSearchHit[] = [
      {
        id: "00000000-0000-0000-0000-000000000003",
        parentDocId: "00000000-0000-0000-0000-000000000099",
        kind: "issue",
        path: "mindset-prod/memex-building-itself/specs/spec-112/issues/issue-4",
        title: "Login button is dead",
        status: "open",
        score: 0.27,
        strategies: ["fts"],
        authorName: null,
        lastUpdatedAt: null,
        matchingSections: [],
        issueSnippet: "Clicking the login button does nothing.",
        issueMatchedVia: "fts",
        issueType: "bug",
      },
    ];

    const out = formatSearchResults("login", hits);
    expect(out).toContain(
      `### mindset-prod/memex-building-itself/specs/spec-112/issues/issue-4 — "Login button is dead" (issue/bug, open)`,
    );
    expect(out).toContain("- (fts): Clicking the login button does nothing.");
    // No UUIDs anywhere — b-36 D-7 hard rule still holds for the new kind.
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(out).not.toMatch(uuidRegex);
    tagAc(AC(13));
  });
});

describe("searchMemex — archived / paused exclusion", () => {
  it("archived specs are excluded by default", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Archived spec target",
      "embeddinghiddenuniquex content here.",
      [],
      provider,
    );

    // Archive it
    await db.execute(sql`UPDATE documents SET archived_at = now() WHERE id = ${spec.id}`);

    const defaultHits = await searchMemex(memexId, "embeddinghiddenuniquex", {
      provider,
      disableVector: true,
    });
    expect(defaultHits.find((h) => h.id === spec.id)).toBeUndefined();

    const includeHits = await searchMemex(memexId, "embeddinghiddenuniquex", {
      provider,
      disableVector: true,
      includeArchived: true,
    });
    // Wait — includeArchived also unhides paused. But archived-only docs that
    // were just hidden should re-appear. We may not see it depending on whether
    // the direct lookup short-circuit fires; this is FTS so we should see it.
    expect(includeHits.find((h) => h.id === spec.id)).toBeDefined();
  });

  it("paused specs are excluded by default", async () => {
    const provider = makeFakeProvider();
    const spec = await seedSpec(
      memexId,
      "Paused spec target",
      "searchhiddenpauseduniquex content here.",
      [],
      provider,
    );

    await db.execute(sql`UPDATE documents SET paused_at = now() WHERE id = ${spec.id}`);

    const defaultHits = await searchMemex(memexId, "searchhiddenpauseduniquex", {
      provider,
      disableVector: true,
    });
    expect(defaultHits.find((h) => h.id === spec.id)).toBeUndefined();

    const includeHits = await searchMemex(memexId, "searchhiddenpauseduniquex", {
      provider,
      disableVector: true,
      includeArchived: true,
    });
    expect(includeHits.find((h) => h.id === spec.id)).toBeDefined();
  });
});

describe("searchMemex — cross-tenant isolation", () => {
  it("does not leak content across memexes", async () => {
    const provider = makeFakeProvider();
    await seedStandard(
      otherMemexId,
      "Other-tenant secret",
      [{ sectionType: "do", content: "secretcrosstenanttokenuniquex" }],
      provider,
    );

    // Resolve the OTHER memex's slug pair so we can assert no hits leak across.
    const otherRow = (await db.execute(sql`
      SELECT n.slug AS namespace_slug, m.slug AS memex_slug
      FROM memexes m INNER JOIN namespaces n ON n.id = m.namespace_id
      WHERE m.id = ${otherMemexId}
      LIMIT 1
    `)) as unknown as Array<{ namespace_slug: string; memex_slug: string }>;
    const otherPrefix = `${otherRow[0].namespace_slug}/${otherRow[0].memex_slug}/`;

    // Use FTS-only for a deterministic check on the unique token; vector
    // similarity over the fake provider's hashed embeddings produces near-equal
    // distances for unrelated content and would create spurious hits.
    const hits = await searchMemex(memexId, "secretcrosstenanttokenuniquex", {
      provider,
      disableVector: true,
    });
    // No hit's canonical path should start with the other Memex's slug pair.
    for (const h of hits) {
      expect(h.path.startsWith(otherPrefix)).toBe(false);
    }
  });

  // spec-199 t-8: the two existing cross-tenant tests both run with
  // disableVector: true — this test executes the runSectionVector
  // WHERE d.memex_id predicate that was previously untouched by tests.
  // makeOrthogonalProvider gives deterministic distances: content containing
  // "floornearmatch" embeds onto dim 0 (distance 0.0 to the query, well below
  // the 0.65 floor) so the vector arm reliably returns it; other content lands
  // on dim 1 (distance 1.0, filtered by the floor).
  it("vector arm does not leak cross-tenant content", async () => {
    const provider = makeOrthogonalProvider("fake-cross-tenant-vector-1536");

    // Identical-topic content in both memexes — if the WHERE clause were absent
    // the vector arm would surface otherMemexId's hit.
    const inTenant = await seedStandard(
      memexId,
      "In-tenant vector isolation check",
      [{ sectionType: "do", content: "floornearmatch veccrosstenantisolationx" }],
      provider,
    );
    await seedStandard(
      otherMemexId,
      "Cross-tenant vector candidate",
      [{ sectionType: "do", content: "floornearmatch veccrosstenantisolationx" }],
      provider,
    );

    const otherRow = (await db.execute(sql`
      SELECT n.slug AS namespace_slug, m.slug AS memex_slug
      FROM memexes m INNER JOIN namespaces n ON n.id = m.namespace_id
      WHERE m.id = ${otherMemexId}
      LIMIT 1
    `)) as unknown as Array<{ namespace_slug: string; memex_slug: string }>;
    const otherPrefix = `${otherRow[0].namespace_slug}/${otherRow[0].memex_slug}/`;

    // No disableVector — exercises runSectionVector's WHERE d.memex_id = ${memexId}.
    const hits = await searchMemex(memexId, "floornearmatch", { provider });

    // In-tenant content IS surfaced by the vector arm.
    expect(hits.find((h) => h.id === inTenant.id)).toBeDefined();
    // Cross-tenant content never leaks regardless of vector similarity.
    for (const h of hits) {
      expect(h.path.startsWith(otherPrefix)).toBe(false);
    }
  });
});

describe("searchMemex — defaults + edges", () => {
  it("returns empty list for an empty query", async () => {
    const hits = await searchMemex(memexId, "   ");
    expect(hits).toEqual([]);
  });

  it("default limit is 8", async () => {
    // We can't easily seed 9+ matching docs cheaply; just check the limit is
    // honored when explicitly set to something tighter.
    const provider = makeFakeProvider();
    const hits = await searchMemex(memexId, "phase", { provider, limit: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe("formatSearchResults — b-34 D-4 spec", () => {
  it("renders zero hits as a No-results line", () => {
    const out = formatSearchResults("nothing here", []);
    expect(out).toContain(`No results for "nothing here".`);
  });

  it("uses path-as-heading and includes no UUIDs", () => {
    const hits: MemexSearchHit[] = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        parentDocId: "00000000-0000-0000-0000-000000000001",
        kind: "spec",
        path: "mindset-int/memex-app/specs/spec-99",
        title: "Sample spec",
        status: "specify",
        score: 0.42,
        strategies: ["fts", "vector"],
        authorName: null,
        lastUpdatedAt: null,
        matchingSections: [
          {
            id: "00000000-0000-0000-0000-000000000010",
            sectionType: "overview",
            title: "Overview",
            content: "Some matching content goes here.",
            matchedVia: "vector",
          },
        ],
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        parentDocId: "00000000-0000-0000-0000-000000000099",
        kind: "decision",
        path: "mindset-int/memex-app/specs/spec-99/decisions/dec-3",
        title: "Sample decision",
        status: "resolved",
        score: 0.31,
        strategies: ["fts"],
        authorName: null,
        lastUpdatedAt: null,
        matchingSections: [],
        decisionSnippet: "Resolved: do the thing.",
        decisionMatchedVia: "fts",
      },
    ];

    const out = formatSearchResults("phase", hits);
    expect(out).toContain(`### mindset-int/memex-app/specs/spec-99 — "Sample spec" (spec, specify)`);
    expect(out).toContain(`### mindset-int/memex-app/specs/spec-99/decisions/dec-3 — "Sample decision" (decision, resolved)`);
    expect(out).toContain(`- Section "Overview" (vector):`);
    expect(out).toContain(`> Some matching content goes here.`);
    expect(out).toContain(`- (fts): Resolved: do the thing.`);
    // No UUIDs anywhere — b-36 D-7 hard rule
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(out).not.toMatch(uuidRegex);
  });

  it("verbose mode adds score, terse omits it", () => {
    const hit: MemexSearchHit = {
      id: "00000000-0000-0000-0000-000000000001",
      parentDocId: "00000000-0000-0000-0000-000000000001",
      kind: "spec",
      path: "x/y/specs/spec-1",
      title: "T",
      status: "specify",
      score: 0.42,
      strategies: ["fts"],
      authorName: null,
      lastUpdatedAt: null,
      matchingSections: [],
    };
    expect(formatSearchResults("q", [hit])).not.toContain("score 0.420");
    expect(formatSearchResults("q", [hit], { verbose: true })).toContain("score 0.420");
  });

  it("truncates snippets longer than 300 chars", () => {
    const long = "abc ".repeat(200); // 800 chars
    const hit: MemexSearchHit = {
      id: "00000000-0000-0000-0000-000000000001",
      parentDocId: "00000000-0000-0000-0000-000000000001",
      kind: "standard",
      path: "x/y/standards/std-1",
      title: "T",
      status: "published",
      score: 0.1,
      strategies: ["fts"],
      authorName: null,
      lastUpdatedAt: null,
      matchingSections: [
        {
          id: "00000000-0000-0000-0000-000000000010",
          sectionType: "do",
          title: null,
          content: long,
          matchedVia: "fts",
        },
      ],
    };
    const out = formatSearchResults("q", [hit]);
    const lines = out.split("\n");
    const snippetLine = lines.find((l) => l.startsWith("  > "));
    expect(snippetLine).toBeDefined();
    // 300 + leading "  > " = 304 chars max
    expect(snippetLine!.length).toBeLessThanOrEqual(304);
    expect(snippetLine!).toContain("…");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// b-34 T-12: self-hit exclusion when the agent is editing a Spec.
// `excludeDocId` is set by the in-app agent's tool handler from
// ctx.currentDocId; it removes the bound Spec from results so the search
// doesn't regurgitate content the agent already has in its Document Context.
// `formatSearchResults({ currentDocId })` adds the `[current doc]` tag when
// the caller opts back in with `includeCurrentDoc: true`.
// ─────────────────────────────────────────────────────────────────────────

describe("searchMemex — excludeDocId (self-hit filter)", () => {
  it("section hits on the bound doc are filtered out", async () => {
    const provider = makeFakeProvider("fake-exclude-section");
    const spec = await seedSpec(
      memexId,
      "Self-filter section target",
      "selfexcludeuniquex content that would otherwise match.",
      [],
      provider,
    );

    // Searching with excludeDocId set to this Spec's id should NOT return it.
    const filtered = await searchMemex(memexId, "selfexcludeuniquex", {
      provider,
      disableVector: true,
      excludeDocId: spec.id,
    });
    expect(filtered.find((h) => h.id === spec.id)).toBeUndefined();

    // Without excludeDocId, the same query DOES return it.
    const unfiltered = await searchMemex(memexId, "selfexcludeuniquex", {
      provider,
      disableVector: true,
    });
    expect(unfiltered.find((h) => h.id === spec.id)).toBeDefined();
  });

  it("decision hits whose parent matches excludeDocId are filtered out", async () => {
    const provider = makeFakeProvider("fake-exclude-decision");
    const spec = await seedSpec(
      memexId,
      "Self-filter decision target",
      "Body.",
      [],
      provider,
    );
    const dec = await seedDecision(
      memexId,
      spec,
      "selfexcludedecisionuniquex",
      "Decision context for exclusion test.",
      null,
      provider,
    );

    const filtered = await searchMemex(memexId, "selfexcludedecisionuniquex", {
      provider,
      disableVector: true,
      excludeDocId: spec.id,
    });
    expect(filtered.find((h) => h.id === dec.id)).toBeUndefined();

    const unfiltered = await searchMemex(memexId, "selfexcludedecisionuniquex", {
      provider,
      disableVector: true,
    });
    expect(unfiltered.find((h) => h.id === dec.id)).toBeDefined();
  });

  it("hits from OTHER docs in the same Memex are never filtered", async () => {
    const provider = makeFakeProvider("fake-exclude-other");
    const specA = await seedSpec(
      memexId,
      "Spec A — bound doc",
      "Body.",
      [],
      provider,
    );
    const specB = await seedSpec(
      memexId,
      "Spec B — neighbour",
      "neighbouruniquetokenx content that should be returned.",
      [],
      provider,
    );

    const hits = await searchMemex(memexId, "neighbouruniquetokenx", {
      provider,
      disableVector: true,
      excludeDocId: specA.id, // bound to A; B should still come back
    });
    expect(hits.find((h) => h.id === specB.id)).toBeDefined();
  });
});

describe("formatSearchResults — [current doc] tag (includeCurrentDoc opt-in)", () => {
  it("tags section-doc hit when its id matches currentDocId", () => {
    const currentDocId = "00000000-0000-0000-0000-0000000000aa";
    const hit: MemexSearchHit = {
      id: currentDocId,
      parentDocId: currentDocId,
      kind: "spec",
      path: "ns/mx/specs/spec-1",
      title: "My Spec",
      status: "specify",
      score: 0.5,
      strategies: ["fts"],
      authorName: null,
      lastUpdatedAt: null,
      matchingSections: [
        {
          id: "00000000-0000-0000-0000-0000000000bb",
          sectionType: "overview",
          title: "Overview",
          content: "Content.",
          matchedVia: "fts",
        },
      ],
    };

    const tagged = formatSearchResults("q", [hit], { currentDocId });
    expect(tagged).toContain("[current doc]");

    const untagged = formatSearchResults("q", [hit]);
    expect(untagged).not.toContain("[current doc]");
  });

  it("tags decision hit when its parentDocId matches currentDocId", () => {
    const parentDocId = "00000000-0000-0000-0000-0000000000aa";
    const hit: MemexSearchHit = {
      id: "00000000-0000-0000-0000-0000000000cc",
      parentDocId,
      kind: "decision",
      path: "ns/mx/specs/spec-1/decisions/dec-7",
      title: "A decision",
      status: "resolved",
      score: 0.4,
      strategies: ["fts"],
      authorName: null,
      lastUpdatedAt: null,
      matchingSections: [],
      decisionSnippet: "Snippet.",
      decisionMatchedVia: "fts",
    };

    const tagged = formatSearchResults("q", [hit], { currentDocId: parentDocId });
    expect(tagged).toContain("[current doc]");
  });

  it("does NOT tag hits whose parentDocId differs from currentDocId", () => {
    const currentDocId = "00000000-0000-0000-0000-0000000000aa";
    const hit: MemexSearchHit = {
      id: "00000000-0000-0000-0000-0000000000dd",
      parentDocId: "00000000-0000-0000-0000-0000000000ee",
      kind: "spec",
      path: "ns/mx/specs/spec-2",
      title: "Other spec",
      status: "specify",
      score: 0.3,
      strategies: ["fts"],
      authorName: null,
      lastUpdatedAt: null,
      matchingSections: [],
    };

    const out = formatSearchResults("q", [hit], { currentDocId });
    expect(out).not.toContain("[current doc]");
  });
});

// ── spec-191: number / short-handle jump in the ⌘K Jump-to lane ────────────────
// resolveJumpTo gains a number-jump arm so typing a bare Spec number (or a short
// `s-178`/`std178`/`doc178` form) navigates to the doc(s) carrying that number.
// We use a FRESH makeTestMemex so the first Spec / Standard / Document each mint
// number 1 (independent per-kind sequences sharing the memex-global number space),
// giving us a deterministic `spec-1` / `std-1` / `doc-1` trio for the ambiguity
// case. The arm reuses lookupByHandle, so it needs no embedding provider.
const SPEC191_AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-191/acs/ac-${n}`;

describe("resolveJumpTo — number / short-handle jump (spec-191)", () => {
  let jumpMemexId: string;
  let specId: string;
  let stdId: string;
  let docId: string;
  let specHandle: string;
  let stdHandle: string;
  let docHandle: string;
  let n: number; // the shared number — 1 in a fresh memex
  const ours = (h: { id: string }) => [specId, stdId, docId].includes(h.id);

  beforeAll(async () => {
    jumpMemexId = await makeTestMemex("jump191");
    const spec = await createDocDraft(jumpMemexId, "Number jump target", "Overview body.", "spec");
    const std = await createStandard(jumpMemexId, {
      title: "Number jump rule",
      sections: [{ sectionType: "do", content: "A rule body." }],
    });
    const doc = await createDocDraft(jumpMemexId, "Number jump note", "Doc body.", "document");
    specId = spec.id;
    stdId = std.id;
    docId = doc.id;
    specHandle = spec.handle;
    stdHandle = std.handle;
    docHandle = doc.handle;
    createdDocIds.push(specId, stdId, docId);
    n = Number(specHandle.split("-")[1]);
  });

  it("a bare Spec number surfaces the Spec as a jumpTo row (ac-1)", async () => {
    tagAc(SPEC191_AC(1));
    const hits = await resolveJumpTo(jumpMemexId, String(n));
    const specHit = hits.find((h) => h.id === specId);
    expect(specHit).toBeDefined();
    expect(specHit?.kind).toBe("spec");
    expect(specHit?.path).toContain(`/specs/${specHandle}`);
  });

  it("a bare number matching all three kinds returns rows ordered spec→std→doc with scores in (0.5,1) (ac-2, ac-7)", async () => {
    tagAc(SPEC191_AC(2));
    tagAc(SPEC191_AC(7));
    // In this fresh memex the three docs share the number (independent sequences
    // each start at 1) — assert that precondition explicitly.
    expect(stdHandle).toBe(`std-${n}`);
    expect(docHandle).toBe(`doc-${n}`);

    const hits = await resolveJumpTo(jumpMemexId, String(n));
    // A bare number doesn't match HANDLE_REGEX (no exact-handle hit) and no Spec
    // title contains the digit (no title-substring rows), so our three docs are
    // the number-jump rows. Filter to them to stay robust to incidental rows.
    const rows = hits.filter(ours);
    expect(rows.map((h) => h.id)).toEqual([specId, stdId, docId]);
    expect(rows.map((h) => h.kind)).toEqual(["spec", "standard", "document"]);
    // Each ranks below an exact full-handle hit (1) and above the title tier (0.5),
    // and strictly descending so the spec→std→doc order is stable.
    for (const h of rows) {
      expect(h.score).toBeGreaterThan(0.5);
      expect(h.score).toBeLessThan(1);
    }
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows[1].score).toBeGreaterThan(rows[2].score);
  });

  it("a short/explicit prefix scopes the jump to one kind (ac-3, ac-8)", async () => {
    tagAc(SPEC191_AC(3));
    tagAc(SPEC191_AC(8));
    // s / s- / spec / spec- + number → the Spec only.
    for (const q of [`s${n}`, `s-${n}`, `spec${n}`, `spec-${n}`]) {
      const rows = (await resolveJumpTo(jumpMemexId, q)).filter(ours);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(specId);
      expect(rows[0].kind).toBe("spec");
    }
    // std + number → the Standard only (longest-first alternation, not the s-branch).
    {
      const rows = (await resolveJumpTo(jumpMemexId, `std${n}`)).filter(ours);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(stdId);
      expect(rows[0].kind).toBe("standard");
    }
    // doc + number → the Document only.
    {
      const rows = (await resolveJumpTo(jumpMemexId, `doc${n}`)).filter(ours);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(docId);
      expect(rows[0].kind).toBe("document");
    }
  });

  it("a number matching no document produces no fabricated jumpTo row (ac-4)", async () => {
    tagAc(SPEC191_AC(4));
    const hits = await resolveJumpTo(jumpMemexId, "999999");
    // No doc carries 999999 across any kind, and no Spec title contains it — the
    // query falls through with an empty jump lane, no fabricated row.
    expect(hits.filter(ours)).toHaveLength(0);
  });

  it("honours Jump-to visibility: archived and demo docs excluded, drafts included (ac-5)", async () => {
    tagAc(SPEC191_AC(5));
    const visMemex = await makeTestMemex("jumpvis191");
    const draftSpec = await createDocDraft(visMemex, "Draft target", "body", "spec");
    const archivedSpec = await createDocDraft(visMemex, "Archived target", "body", "spec");
    await db.execute(sql`UPDATE documents SET archived_at = now() WHERE id = ${archivedSpec.id}`);
    const demoSpec = await createDocDraft(visMemex, "Demo target", "body", "spec", undefined, {
      isDemo: true,
    });
    createdDocIds.push(draftSpec.id, archivedSpec.id, demoSpec.id);

    const numOf = (handle: string) => Number(handle.split("-")[1]);

    // A freshly created Spec is status 'draft' — drafts are eligible (no status filter).
    const draftHits = await resolveJumpTo(visMemex, String(numOf(draftSpec.handle)));
    expect(draftHits.find((h) => h.id === draftSpec.id)).toBeDefined();
    expect(draftHits.find((h) => h.id === draftSpec.id)?.status).toBe("draft");

    // Archived excluded (lookupByHandle filters archived_at IS NULL).
    const archivedHits = await resolveJumpTo(visMemex, String(numOf(archivedSpec.handle)));
    expect(archivedHits.find((h) => h.id === archivedSpec.id)).toBeUndefined();

    // Demo excluded (lookupByHandle filters is_demo IS NOT TRUE — spec-178 dec-11).
    const demoHits = await resolveJumpTo(visMemex, String(numOf(demoSpec.handle)));
    expect(demoHits.find((h) => h.id === demoSpec.id)).toBeUndefined();
  });

  it("does not collide with the exact-handle or @name paths (ac-9)", async () => {
    tagAc(SPEC191_AC(9));
    // A full handle is resolved by the exact-handle arm (score 1) and deduped — the
    // number arm sees it in seenDocIds and does NOT add a second row at 0.9.
    const handleHits = await resolveJumpTo(jumpMemexId, specHandle); // e.g. "spec-1"
    const specRows = handleHits.filter((h) => h.id === specId);
    expect(specRows).toHaveLength(1);
    expect(specRows[0].score).toBe(1);

    // An @name assignee query carries no digit in the numeric position, so the
    // number grammar never matches and contributes no number row.
    const atHits = await resolveJumpTo(jumpMemexId, "@dev");
    expect(atHits.filter(ours)).toHaveLength(0);
  });

  it("searchMemex (the agent core) does NOT short-circuit a bare number to a handle hit (ac-10)", async () => {
    tagAc(SPEC191_AC(10));
    // The number-jump arm lives ONLY in resolveJumpTo (dec-3). HANDLE_REGEX still
    // matches only full `kind-N` handles, so a bare number must not short-circuit
    // searchMemex to spec-N. With vector disabled, a bare digit has no FTS lexeme
    // match against our text → no handle hit for the Spec.
    const hits = await searchMemex(jumpMemexId, String(n), { disableVector: true });
    const handleHit = hits.find(
      (h) => h.id === specId && h.strategies.includes("handle"),
    );
    expect(handleHit).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// spec-285: author (WHO) + last-changed (WHEN) on every search hit.
//   - dec-1: decision/section hits use the denormalised actor_name; document &
//     issue hits resolve created_by_user_id → users.name ?? email.
//   - dec-2: one timestamp per hit — last-modified where present, created_at
//     fallback (decisions have no updated_at).
//   - dec-3 / ac-8: formatSearchResults renders ` · <author>, <YYYY-MM-DD>` so
//     the MCP tool AND the React agent (which reuse the same handler) see it.
// ═══════════════════════════════════════════════════════════════════════════

const SPEC285_AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-285/acs/ac-${n}`;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

describe("formatSearchResults — WHO/WHEN byline (spec-285 ac-8)", () => {
  const base: MemexSearchHit = {
    id: "00000000-0000-0000-0000-000000000001",
    parentDocId: "00000000-0000-0000-0000-000000000001",
    kind: "spec",
    path: "ns/mx/specs/spec-7",
    title: "A spec",
    status: "build",
    score: 0.5,
    strategies: ["fts"],
    matchingSections: [],
    authorName: null,
    lastUpdatedAt: null,
  };

  it("renders ` · <author>, <YYYY-MM-DD>` when both are present", () => {
    tagAc(SPEC285_AC(8));
    const out = formatSearchResults("q", [
      { ...base, authorName: "Ada Lovelace", lastUpdatedAt: "2026-05-28T09:30:00.000Z" },
    ]);
    expect(out).toContain(`(spec, build) · Ada Lovelace, 2026-05-28`);
    // No UUIDs in the rendered output (b-36 D-7 still holds).
    const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(out).not.toMatch(uuidRegex);
  });

  it("renders author alone when there is no timestamp", () => {
    tagAc(SPEC285_AC(8));
    const out = formatSearchResults("q", [{ ...base, authorName: "Grace Hopper" }]);
    expect(out).toContain(`(spec, build) · Grace Hopper`);
    expect(out).not.toContain("Grace Hopper,"); // no trailing comma/date
  });

  it("renders the date alone when there is no author", () => {
    tagAc(SPEC285_AC(8));
    const out = formatSearchResults("q", [
      { ...base, lastUpdatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(out).toContain(`(spec, build) · 2026-01-02`);
  });

  it("emits NO byline when neither author nor timestamp is set", () => {
    tagAc(SPEC285_AC(8));
    const out = formatSearchResults("q", [base]);
    const headingLine = out.split("\n").find((l) => l.startsWith("### "));
    expect(headingLine).toBeDefined();
    expect(headingLine).not.toContain(" · ");
    expect(headingLine).toContain(`(spec, build)`);
  });
});

describe("searchMemex — author + timestamp population (spec-285 ac-6/ac-7)", () => {
  it("decision hits carry the denormalised actor_name + created_at (dec-1/dec-2)", async () => {
    tagAc(SPEC285_AC(6));
    tagAc(SPEC285_AC(7));
    const provider = makeFakeProvider("fake-author-decision");
    const spec = await seedSpec(memexId, "Author decision host", "Body.", [], provider);
    const dec = await seedDecision(
      memexId,
      spec,
      "authordecisionuniquetokenx approach",
      "Context.",
      "Resolved.",
      provider,
    );
    // Stamp a denormalised WHO the way the write path would (std-32).
    await db.execute(
      sql`UPDATE decisions SET actor_name = 'Ada Lovelace', actor_user_id = NULL WHERE id = ${dec.id}`,
    );

    const hits = await searchMemex(memexId, "authordecisionuniquetokenx", {
      provider,
      kind: "decision",
      disableVector: true,
    });
    const hit = hits.find((h) => h.id === dec.id);
    expect(hit).toBeDefined();
    expect(hit!.authorName).toBe("Ada Lovelace");
    // WHEN is the decision's created_at (no updated_at column), as an ISO string.
    expect(hit!.lastUpdatedAt).toMatch(ISO_RE);
  });

  it("section/doc hits prefer the section's denormalised actor_name (dec-1)", async () => {
    tagAc(SPEC285_AC(6));
    const provider = makeFakeProvider("fake-author-section");
    const spec = await seedSpec(
      memexId,
      "Author section host",
      "authorsectionuniquetokenx content here.",
      [],
      provider,
    );
    await db.execute(
      sql`UPDATE doc_sections SET actor_name = 'Grace Hopper' WHERE doc_id = ${spec.id}`,
    );

    const hits = await searchMemex(memexId, "authorsectionuniquetokenx", {
      provider,
      disableVector: true,
    });
    const hit = hits.find((h) => h.id === spec.id);
    expect(hit).toBeDefined();
    expect(hit!.authorName).toBe("Grace Hopper");
    expect(hit!.lastUpdatedAt).toMatch(ISO_RE);
  });

  it("doc hits with no section actor_name resolve created_by_user_id → name (dec-1)", async () => {
    tagAc(SPEC285_AC(6));
    const provider = makeFakeProvider("fake-author-docfallback");
    const author = await upsertUserByEmail("ada.author@example.com");
    const spec = await seedSpec(
      memexId,
      "Author doc-fallback host",
      "authordocfallbackuniquetokenx content here.",
      [],
      provider,
    );
    // No section actor_name → fall back to the resolved document creator.
    await db.execute(
      sql`UPDATE doc_sections SET actor_name = NULL WHERE doc_id = ${spec.id}`,
    );
    await db.execute(
      sql`UPDATE documents SET created_by_user_id = ${author.id} WHERE id = ${spec.id}`,
    );

    const hits = await searchMemex(memexId, "authordocfallbackuniquetokenx", {
      provider,
      disableVector: true,
    });
    const hit = hits.find((h) => h.id === spec.id);
    expect(hit).toBeDefined();
    // upsertUserByEmail sets no display name, so the resolver falls to email.
    expect(hit!.authorName).toBe("ada.author@example.com");
  });

  it("issue hits resolve created_by_user_id → name + carry updated_at (dec-1/dec-2)", async () => {
    tagAc(SPEC285_AC(6));
    tagAc(SPEC285_AC(7));
    const provider = makeFakeProvider("fake-author-issue");
    const author = await upsertUserByEmail("grace.issue@example.com");
    const spec = await seedSpec(memexId, "Author issue host", "Body.", [], provider);
    const issue = await seedIssue(
      memexId,
      spec,
      "authorissueuniquetokenx regression",
      "An issue with a resolvable author.",
      "bug",
      provider,
    );
    await db.execute(
      sql`UPDATE issues SET created_by_user_id = ${author.id} WHERE id = ${issue.id}`,
    );

    const hits = await searchMemex(memexId, "authorissueuniquetokenx", {
      provider,
      kind: "issue",
      disableVector: true,
    });
    const hit = hits.find((h) => h.id === issue.id);
    expect(hit).toBeDefined();
    expect(hit!.authorName).toBe("grace.issue@example.com");
    expect(hit!.lastUpdatedAt).toMatch(ISO_RE);
  });
});

describe("searchMemex → formatSearchResults — end-to-end byline (spec-285 ac-1/ac-2)", () => {
  it("a real decision search renders WHO/WHEN in the markdown the MCP + React agents read", async () => {
    tagAc(SPEC285_AC(1));
    tagAc(SPEC285_AC(2));
    const provider = makeFakeProvider("fake-author-e2e");
    const spec = await seedSpec(memexId, "E2E byline host", "Body.", [], provider);
    const dec = await seedDecision(
      memexId,
      spec,
      "authore2euniquetokenx approach",
      "Context.",
      "Resolved.",
      provider,
    );
    await db.execute(
      sql`UPDATE decisions SET actor_name = 'Ada Lovelace', actor_user_id = NULL WHERE id = ${dec.id}`,
    );

    // The exact path the MCP search_memex handler runs — and the React UI agent
    // reuses this same handler via executeToolRemote (spec-285 Architecture
    // finding 1), so a passing render here proves both agent surfaces (ac-2).
    const hits = await searchMemex(memexId, "authore2euniquetokenx", {
      provider,
      kind: "decision",
      disableVector: true,
    });
    const out = formatSearchResults("authore2euniquetokenx", hits);
    expect(out).toContain("Ada Lovelace");
    expect(out).toMatch(/· Ada Lovelace, \d{4}-\d{2}-\d{2}/);
  });
});

describe("spec-285 — additive, non-breaking, single-source (ac-4)", () => {
  it("a hit with no author/timestamp renders the exact legacy heading (no stray byline)", () => {
    tagAc(SPEC285_AC(4));
    // An existing consumer's hit (pre-285 shape, nulls for the new fields) must
    // render byte-identically to before — additive change, no regression.
    const legacy: MemexSearchHit = {
      id: "00000000-0000-0000-0000-000000000001",
      parentDocId: "00000000-0000-0000-0000-000000000001",
      kind: "standard",
      path: "ns/mx/standards/std-3",
      title: "A standard",
      status: "published",
      score: 0.2,
      strategies: ["fts"],
      matchingSections: [
        {
          id: "00000000-0000-0000-0000-000000000010",
          sectionType: "do",
          title: "Do",
          content: "Some rule.",
          matchedVia: "fts",
        },
      ],
      authorName: null,
      lastUpdatedAt: null,
    };
    const out = formatSearchResults("q", [legacy]);
    // Heading is the legacy format exactly — no ` · ` byline appended.
    expect(out).toContain(`### ns/mx/standards/std-3 — "A standard" (standard, published)`);
    const headingLine = out.split("\n").find((l) => l.startsWith("### "))!;
    expect(headingLine.endsWith("(standard, published)")).toBe(true);
    // Section rendering is untouched.
    expect(out).toContain(`- Section "Do" (fts):`);
    expect(out).toContain(`  > Some rule.`);
  });

  it("the new fields are part of MemexSearchHit (single source) so REST inherits them", () => {
    tagAc(SPEC285_AC(4));
    // Both new fields live on MemexSearchHit itself — the REST route's
    // SearchContentHit = Omit<MemexSearchHit,"id"|"parentDocId"> therefore
    // inherits them with no separate type to keep in sync (single source).
    const hit: MemexSearchHit = {
      id: "00000000-0000-0000-0000-000000000001",
      parentDocId: "00000000-0000-0000-0000-000000000001",
      kind: "spec",
      path: "ns/mx/specs/spec-1",
      title: "T",
      status: "build",
      score: 0.1,
      strategies: ["fts"],
      matchingSections: [],
      authorName: "Ada Lovelace",
      lastUpdatedAt: "2026-05-28T00:00:00.000Z",
    };
    // Structurally present on the hit shape that the REST projection spreads.
    expect(Object.prototype.hasOwnProperty.call(hit, "authorName")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(hit, "lastUpdatedAt")).toBe(true);
  });
});

describe("spec-285 — legible in both surfaces: markdown AND structured (ac-5)", () => {
  it("renders a human byline in markdown while keeping discrete structured fields", () => {
    tagAc(SPEC285_AC(5));
    const hit: MemexSearchHit = {
      id: "00000000-0000-0000-0000-000000000001",
      parentDocId: "00000000-0000-0000-0000-000000000001",
      kind: "decision",
      path: "ns/mx/specs/spec-1/decisions/dec-2",
      title: "A decision",
      status: "resolved",
      score: 0.3,
      strategies: ["fts"],
      matchingSections: [],
      decisionSnippet: "Resolved: do the thing.",
      decisionMatchedVia: "fts",
      authorName: "Ryan Soosayraj",
      lastUpdatedAt: "2026-05-28T12:00:00.000Z",
    };

    // Surface 1 — the MCP/React-agent markdown: human-readable "name, date".
    const md = formatSearchResults("q", [hit]);
    expect(md).toMatch(/· Ryan Soosayraj, 2026-05-28/);

    // Surface 2 — the structured field the React agent / REST consume: discrete,
    // not buried in prose. An agent can cite "<name>, <date>" without parsing.
    expect(hit.authorName).toBe("Ryan Soosayraj");
    expect(hit.lastUpdatedAt!.slice(0, 10)).toBe("2026-05-28");
  });
});
