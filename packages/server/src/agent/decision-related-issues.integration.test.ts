// spec-112 t-7 — decision-time auto-surfacing of related Issues.
//
// When a decision is created or resolved, the JIT-nudge channel appends related
// Issues whose semantic overlap with the decision text clears a relevance
// threshold (reusing searchMemex(kind:'issue')); below threshold nothing is
// appended. Informational only — no mutation, no phase blocking.
//
// AC emission: every test that proves an AC calls tagAc('<full canonical ref>').

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { documents, issues, memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createIssue } from "../services/issues.js";
import { embedAndStoreIssue } from "../services/memex-embeddings.js";
import { toolSpecs } from "./tool-specs.js";
import { relatedIssuesForDecision, relatedIssuesNudge } from "./tool-specs.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import type { ToolCtx } from "./tool-specs.js";
import type { EmbeddingProvider } from "../services/embedding-provider.js";
import { tagAc } from "@memex-ai-ac/vitest";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-112/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  for (const id of createdDocIds) {
    await db.delete(issues).where(eq(issues.docId, id)).catch(() => {});
  }
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// Topic-aware fake provider so the vector arm of searchMemex is deterministic
// and the relevance threshold can be proven offline with no API calls. Each text
// is mapped to an almost-one-hot vector dominated by the dimension of whichever
// topic word it mentions (a tiny per-char jitter keeps vectors distinct without
// blurring topic separation). Same-topic vectors are near-collinear (cosine ≈ 1,
// distance ≈ 0); different-topic vectors are near-orthogonal (cosine ≈ 0,
// distance ≈ 1). That clean separation is what lets the score-ratio threshold
// admit the on-topic Issue and drop the off-topic one.
function makeFakeProvider(name = "fake-rel-1536"): EmbeddingProvider {
  const topics: Record<string, number> = {
    caching: 0,
    kitchen: 1,
    auth: 2,
    payment: 3,
  };
  return {
    name,
    dim: 1536,
    maxBatchSize: 16,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const lower = t.toLowerCase();
        const vec = new Array<number>(1536).fill(0);
        // Dominant topic dimension(s).
        let matched = false;
        for (const [word, dim] of Object.entries(topics)) {
          if (lower.includes(word)) {
            vec[dim] = 1;
            matched = true;
          }
        }
        // A tiny deterministic jitter on a high dimension so two distinct texts
        // never collide exactly, without disturbing topic separation. For a
        // topic-less text this is the only non-zero component (it will be
        // orthogonal to every topic vector → maximal distance).
        const seed = Array.from(t).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        vec[1000 + (seed % 400)] += matched ? 0.01 : 1;
        return vec;
      });
    },
  };
}

let memexId: string;
beforeAll(async () => {
  memexId = await makeTestMemex("decrelissue");
});

async function slugsFor(id: string): Promise<{ namespace: string; memex: string }> {
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, id) });
  if (!mx) throw new Error(`memex ${id} not found`);
  const ns = await db.query.namespaces.findFirst({ where: eq(namespaces.id, mx.namespaceId) });
  if (!ns) throw new Error(`ns for ${id} not found`);
  return { namespace: ns.slug, memex: mx.slug };
}

async function makeSpec(title: string): Promise<{ id: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, `${title} overview`, "spec");
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle };
}

// Hand-rolled agent ctx mirroring buildAgentCtx (see issue-tools.integration.test.ts).
function ctxFor(boundMemex: string, verbose: boolean): ToolCtx {
  return {
    userId: "00000000-0000-0000-0000-000000000000",
    // spec-219 Phase 2: handlers park a structured signal here; the related-issue
    // prose is authored by composeGuidanceEnvelope from signal.issueHits.
    footerSlot: {},
    resolveMemexFromEntity: async () => boundMemex,
    resolveMemex: async () => boundMemex,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(`Ref redirected: "${ref}" → "${result.newRef}".`);
      }
      if ("notFound" in result) {
        throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      }
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== boundMemex) {
        throw new NotFoundError(`Ref "${ref}" not found.`);
      }
      return {
        entity,
        memexId: doc.memexId,
        doc,
        slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
      };
    },
    workspaceUrl: async () => (verbose ? "https://test.example" : ""),
    verbose,
  };
}

function spec(name: string) {
  const s = toolSpecs.find((t) => t.name === name);
  if (!s) throw new Error(`tool spec ${name} not found`);
  return s;
}

// ──────────────────────────────────────────────────────────────────────────
// ac-15 — over-threshold Issues are appended (with cross-Spec refs); below
// threshold none are. Proven at the threshold-helper boundary with an injected
// provider so the vector-path ranking is deterministic and offline.
// ──────────────────────────────────────────────────────────────────────────
describe("relatedIssuesForDecision — threshold gating, cross-Spec (ac-15)", () => {
  it("appends Issues over the relevance threshold and drops those below it", async () => {
    tagAc(AC(15));
    const provider = makeFakeProvider();

    // Two Issues on a DIFFERENT Spec than the decision: one strongly on-topic
    // (caching) and one off-topic (kitchen). The decision is about caching, so
    // the on-topic Issue must clear the threshold and the off-topic one must not.
    const issueHome = await makeSpec("Issue Home Spec (rel-threshold)");
    const onTopic = await createIssue({
      memexId,
      docId: issueHome.id,
      title: "Caching layer evicts entries too eagerly",
      body: "The caching cache thrashes under load and re-fetches constantly",
      type: "bug",
    });
    const offTopic = await createIssue({
      memexId,
      docId: issueHome.id,
      title: "Kitchen rota needs tidying",
      body: "The kitchen kitchen cleaning schedule is out of date",
      type: "todo",
    });
    // Embed both so the vector arm has rows to rank against the decision text.
    await embedAndStoreIssue(onTopic.id, { provider });
    await embedAndStoreIssue(offTopic.id, { provider });

    // Decision content tokens are a subset of the on-topic Issue's text so the
    // FTS relevance gate fires for it; the off-topic Issue shares no tokens.
    const hits = await relatedIssuesForDecision(
      memexId,
      "caching layer evicts entries",
      provider,
    );
    const titles = hits.map((h) => h.title);

    // The on-topic Issue is over threshold and surfaced...
    expect(titles).toContain("Caching layer evicts entries too eagerly");
    // ...and the off-topic Issue is below threshold and NOT surfaced (ac-15).
    expect(titles).not.toContain("Kitchen rota needs tidying");

    // Every surfaced hit carries a cross-Spec canonical ref (path under the
    // Issue's home Spec, not the decision's Spec).
    const surfaced = hits.find((h) => h.title === "Caching layer evicts entries too eagerly");
    expect(surfaced).toBeTruthy();
    expect(surfaced!.path).toContain(`/specs/${issueHome.handle}/issues/issue-`);
  });

  it("appends NOTHING when no Issue clears the threshold (decision unrelated to any Issue)", async () => {
    tagAc(AC(15));
    const provider = makeFakeProvider();

    const issueHome = await makeSpec("Lonely Issue Spec (rel-threshold)");
    const lonely = await createIssue({
      memexId,
      docId: issueHome.id,
      title: "Payment retries are flaky",
      body: "The payment payment path needs idempotent retry",
      type: "bug",
    });
    await embedAndStoreIssue(lonely.id, { provider });

    // A decision sharing NO topic word + no FTS token with the lonely Issue.
    const hits = await relatedIssuesForDecision(
      memexId,
      "Auth: which auth token rotation cadence should we adopt?",
      provider,
    );
    expect(hits.map((h) => h.title)).not.toContain("Payment retries are flaky");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-4 — a related Issue from ANOTHER Spec surfaces while a decision is being
// considered (create_decision) and resolved (resolve_decision), via the JIT
// nudge appended to the tool response. Driven end-to-end through the handlers.
// resolveEmbeddingProvider() is env-driven (FTS-only in CI), so a distinctive
// shared token makes the cross-Spec match deterministic without embeddings.
// ──────────────────────────────────────────────────────────────────────────
describe("decision JIT nudge surfaces a cross-Spec related Issue (ac-4)", () => {
  it("create_decision appends a related Issue raised on a DIFFERENT Spec", async () => {
    tagAc(AC(4));
    const issueHome = await makeSpec("Cross-Spec Issue Home (create)");
    const decisionHome = await makeSpec("Decision Home Spec (create)");

    await createIssue({
      memexId,
      docId: issueHome.id,
      title: "Quibblewump indexer drops rows",
      body: "The quibblewump indexer silently skips rows on batch import",
      type: "bug",
    });

    const slugs = await slugsFor(memexId);
    const decRefArg = `${slugs.namespace}/${slugs.memex}/specs/${decisionHome.handle}`;
    const ctx = ctxFor(memexId, false);

    // Decision content tokens (quibblewump, indexer, batch, import, rows) are a
    // subset of the cross-Spec Issue's text so the FTS relevance gate fires.
    // (The handler searches title + context; both stay within the Issue's token
    // set so plainto_tsquery's AND semantics still match.)
    await spec("create_decision").handler(
      {
        ref: decRefArg,
        title: "quibblewump indexer batch import rows",
        context: "quibblewump indexer batch import rows skips silently",
      },
      ctx,
    );

    // spec-219 Phase 2 (sole-author): the handler parks the related Issues as a
    // structured signal; composeGuidanceEnvelope authors the prose via
    // relatedIssuesNudge. The related Issue from the OTHER Spec is surfaced
    // informationally, with its cross-Spec ref.
    const signal = ctx.footerSlot?.signal;
    expect(signal?.kind).toBe("decision_created");
    const nudge = signal && "issueHits" in signal ? relatedIssuesNudge(signal.issueHits) : "";
    expect(nudge).toContain("Related Issues");
    expect(nudge).toContain(`/specs/${issueHome.handle}/issues/issue-`);
    expect(nudge).toContain("Quibblewump indexer drops rows");
    // Informational only — the nudge says nothing was changed.
    expect(nudge.toLowerCase()).toContain("nothing was changed");
  });

  it("resolve_decision appends a related Issue raised on a DIFFERENT Spec", async () => {
    tagAc(AC(4));
    const issueHome = await makeSpec("Cross-Spec Issue Home (resolve)");
    const decisionHome = await makeSpec("Decision Home Spec (resolve)");

    await createIssue({
      memexId,
      docId: issueHome.id,
      title: "Flibbertron retry storms the API",
      body: "The flibbertron retry loop hammers the upstream API with no backoff",
      type: "bug",
    });

    const slugs = await slugsFor(memexId);
    const decHomeRef = `${slugs.namespace}/${slugs.memex}/specs/${decisionHome.handle}`;
    const ctx = ctxFor(memexId, false);

    // searchMemex's FTS arm ANDs content terms (plainto_tsquery), and the
    // resolve handler searches `title + resolution`. So both must stay within
    // the Issue's token set for the FTS gate to fire. Title "flibbertron" is a
    // subset token; the create-time context ("Weigh the options") adds tokens
    // the Issue lacks, so the CREATE nudge stays quiet — isolating the resolve
    // path we assert below.
    const created = await spec("create_decision").handler(
      { ref: decHomeRef, title: "flibbertron", context: "Weigh the options." },
      ctx,
    );
    const decRef = created.match(/ref: (\S+\/decisions\/dec-\d+)/)![1];
    expect(created).not.toContain("Related Issues");

    // Resolution + title content tokens (flibbertron, retry, loop, storms, api,
    // backoff) are all a subset of the cross-Spec Issue's text → FTS gate fires.
    await spec("resolve_decision").handler(
      {
        ref: decRef,
        resolution: "flibbertron retry loop storms api backoff",
      },
      ctx,
    );

    // spec-219 Phase 2: the resolve handler parks a decision_resolved signal;
    // composeGuidanceEnvelope authors the related-issues prose from issueHits.
    const signal = ctx.footerSlot?.signal;
    expect(signal?.kind).toBe("decision_resolved");
    const nudge = signal && "issueHits" in signal ? relatedIssuesNudge(signal.issueHits) : "";
    expect(nudge).toContain("Related Issues");
    expect(nudge).toContain(`/specs/${issueHome.handle}/issues/issue-`);
    expect(nudge).toContain("Flibbertron retry storms the API");
  });
});
