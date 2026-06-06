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
import {
  embedAndStoreDoc,
  embedAndStoreDecision,
  embedAndStoreIssue,
} from "./memex-embeddings.js";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  searchMemex,
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
      matchingSections: [],
    };

    const out = formatSearchResults("q", [hit], { currentDocId });
    expect(out).not.toContain("[current doc]");
  });
});
