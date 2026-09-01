// spec-521 t-6 — search hits state how old their content is, and carry no
// reference count.
//
// WHY RECENCY (dec-7). A merely-stale Spec currently reads identically to a fresh
// one. Supersession catches the case where somebody recorded the replacement;
// recency catches the far commoner case where nobody did.
//
// WHY PER-KIND (ac-9). "How old is this decision" means "when was this settled", not
// "when was the row first written" — so a decision hit's age comes from
// LAST-RESOLVED and everything else's from LAST-UPDATED. Asserting the same thing
// for both kinds would not prove the rule, so the two are asserted separately, with
// timestamps deliberately set far apart.
//
// WHY THE ac-10 TEST IS A NEGATIVE WITH TEETH. Reference-frequency counts were
// DROPPED, not deferred — the cost is a slower, more convoluted hot retrieval path
// for a rough proxy for centrality. A negative AC is easy to "satisfy" by simply not
// having built the thing, so the assertions below check the rendered payload, the hit
// type, AND the retrieval source, rather than trusting absence.
//
// std-37: per-worker-unique identifiers; teardown scoped to this file's rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, decisions } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft } from "./documents.js";
import { createDecision, resolveDecision } from "./decisions.js";
import { supersedeSpec } from "./supersession.js";
import { formatSearchResults, searchMemex } from "./memex-search.js";
import type { MemexSearchHit } from "./memex-search.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-521/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const createdDocIds: string[] = [];
const REST: { channel: "rest_ui"; actorUserId?: string } = { channel: "rest_ui" };

let memexId: string;
let devUserId: string;

// A fixed "now" so every rendered age is deterministic.
const NOW = new Date("2026-08-06T12:00:00.000Z");
const DOC_UPDATED = new Date("2026-08-04T12:00:00.000Z"); // 2d before NOW
const DEC_RESOLVED = new Date("2026-06-21T12:00:00.000Z"); // ~7w before NOW

function hitFor(hits: MemexSearchHit[], pathFragment: string): MemexSearchHit {
  const hit = hits.find((h) => h.path.includes(pathFragment));
  if (!hit) throw new Error(`no hit for ${pathFragment} in ${hits.map((h) => h.path).join(", ")}`);
  return hit;
}

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s521rec");
  memexId = made.memexId;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
  REST.actorUserId = devUserId;
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db
      .update(documents)
      .set({ supersededByDocId: null })
      .where(inArray(documents.id, createdDocIds))
      .catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════════
// ac-9 — recency on every hit, from the right timestamp per kind
// ══════════════════════════════════════════════════════════════════

describe("ac-9 — every hit states how old its content is", () => {
  it("a DECISION hit's recency comes from LAST-RESOLVED, not from when the row was created", async () => {
    tagAc(AC(9));
    const doc = await createDocDraft(
      memexId,
      "Zibbleflax retrieval approach",
      "The zibbleflax purpose.",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(doc.id);
    const dec = await createDecision(
      memexId,
      doc.id,
      "Which zibbleflax cache do we use?",
      "zibbleflax context",
      "human",
      REST,
    );
    await resolveDecision(memexId, dec.id, "Redis.", undefined, REST);
    // Force the two timestamps far apart, so a formatter reading created_at instead of
    // resolved_at renders a visibly different age and the test fails loudly.
    await db
      .update(decisions)
      .set({ resolvedAt: DEC_RESOLVED, createdAt: DOC_UPDATED })
      .where(eq(decisions.id, dec.id));

    const hits = await searchMemex(memexId, "zibbleflax", { disableVector: true });
    const hit = hitFor(hits, "/decisions/dec-");
    expect(hit.recencyVerb).toBe("resolved");
    expect(hit.recencyAt).toBe(DEC_RESOLVED.toISOString());

    const out = formatSearchResults("zibbleflax", hits, { now: NOW });
    const heading = out.split("\n").find((l) => l.includes("/decisions/dec-"));
    expect(heading).toContain("resolved ");
    // ~7 weeks, not the 2 days created_at would have produced.
    expect(heading).toMatch(/resolved \d+w ago/);
    expect(heading).not.toMatch(/resolved 2d ago/);
  });

  it("an UNRESOLVED decision says `updated`, never claiming a resolution it does not have", async () => {
    tagAc(AC(9));
    const doc = await createDocDraft(
      memexId,
      "Wobbertine open question",
      "The wobbertine purpose.",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(doc.id);
    await createDecision(
      memexId,
      doc.id,
      "Which wobbertine shape?",
      "wobbertine context, still open",
      "human",
      REST,
    );
    const hits = await searchMemex(memexId, "wobbertine", { disableVector: true });
    const hit = hitFor(hits, "/decisions/dec-");
    expect(hit.recencyVerb).toBe("updated");
    expect(hit.recencyAt).toBeTruthy();
    const out = formatSearchResults("wobbertine", hits, { now: NOW });
    const heading = out.split("\n").find((l) => l.includes("/decisions/dec-"));
    expect(heading).toContain("updated ");
    expect(heading).not.toContain("resolved ");
  });

  it("a SPEC hit's recency comes from LAST-UPDATED", async () => {
    tagAc(AC(9));
    const doc = await createDocDraft(
      memexId,
      "Frimbulate the ingest",
      "The frimbulate purpose.",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(doc.id);
    const hits = await searchMemex(memexId, "frimbulate", { disableVector: true });
    const hit = hitFor(hits, `/specs/${doc.handle}`);
    expect(hit.recencyVerb).toBe("updated");
    expect(hit.recencyAt).toBeTruthy();
    const out = formatSearchResults("frimbulate", hits, { now: NOW });
    const heading = out.split("\n").find((l) => l.includes(`/specs/${doc.handle}`));
    expect(heading).toContain("updated ");
  });

  it("EVERY hit in a multi-hit result carries the indicator", async () => {
    tagAc(AC(9));
    // "on every hit" is the part of dec-7 that is NOT a build-time shape call, so it
    // is asserted across a whole result set rather than one representative hit.
    for (const n of [1, 2, 3]) {
      const doc = await createDocDraft(
        memexId,
        `Grobnitz variant ${n}`,
        "The grobnitz purpose.",
        "spec",
        undefined,
        undefined,
        devUserId,
        REST,
      );
      createdDocIds.push(doc.id);
    }
    const hits = await searchMemex(memexId, "grobnitz", { disableVector: true });
    expect(hits.length).toBeGreaterThanOrEqual(3);
    const out = formatSearchResults("grobnitz", hits, { now: NOW });
    const headings = out.split("\n").filter((l) => l.startsWith("### "));
    expect(headings.length).toBe(hits.length);
    for (const h of headings) {
      expect(h).toMatch(/ · (resolved|updated) /);
    }
  });

  it("the indicator uses the same human-readable relative form as the byline", async () => {
    tagAc(AC(9));
    const hits = await searchMemex(memexId, "grobnitz", { disableVector: true });
    const out = formatSearchResults("grobnitz", hits, { now: NOW });
    const heading = out.split("\n").find((l) => l.startsWith("### "));
    // The shared timeAgo() vocabulary: "just now", "Nm/h/d/w ago", or an absolute
    // date past ~8 weeks. Whichever it is, it must be human-readable prose and never
    // a raw ISO timestamp — that is the ac-9 requirement, not a particular unit.
    // ⚠ {3,4} AND NOT {3} — DO NOT "TIDY" THIS BACK.
    // `en-GB` with month:'short' renders SEPTEMBER as "Sept" — four letters. Every other
    // month is three: Jan Feb Mar Apr May Jun Jul Aug **Sept** Oct Nov Dec. A \w{3} match
    // therefore fails for the whole month of September, every year, and passes the other
    // eleven. It broke every PR in the repo at midnight on 2026-09-01 with the same commit
    // that had been green all August.
    // Latent here rather than firing today: the alternation usually takes the
    // relative-date branch, so this one only breaks when the absolute branch is
    // reached in September. Fixed with the others so it cannot surface later.
    expect(heading).toMatch(/(resolved|updated) (just now|\d+[mhdw] ago|\d{1,2} \w{3,4} \d{4})/);
    expect(heading).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-7 — the search-hit half of the supersession pointer
// ══════════════════════════════════════════════════════════════════

describe("ac-7 — a search hit on a superseded Spec names its successor", () => {
  it("the label carries `superseded by spec-N`", async () => {
    tagAc(AC(7));
    const pred = await createDocDraft(
      memexId,
      "Blorptangle old approach",
      "The blorptangle purpose.",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    const succ = await createDocDraft(
      memexId,
      "Blorptangle new approach",
      "The blorptangle successor purpose.",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(pred.id, succ.id);
    await supersedeSpec(memexId, pred.id, succ.id, "absorbed", REST);

    const hits = await searchMemex(memexId, "blorptangle", { disableVector: true });
    const hit = hitFor(hits, `/specs/${pred.handle}`);
    expect(hit.supersededByHandle).toBe(succ.handle);

    const out = formatSearchResults("blorptangle", hits, { now: NOW });
    const heading = out.split("\n").find((l) => l.includes(`/specs/${pred.handle}`));
    expect(heading).toContain(`superseded by ${succ.handle}`);
    // The successor's own hit is not marked.
    const succHeading = out.split("\n").find((l) => l.includes(`/specs/${succ.handle}`));
    expect(succHeading).not.toContain("superseded by");
  });

  it("an ordinary hit carries no supersession clause", async () => {
    tagAc(AC(7));
    const hits = await searchMemex(memexId, "frimbulate", { disableVector: true });
    const out = formatSearchResults("frimbulate", hits, { now: NOW });
    expect(out).not.toContain("superseded by");
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-10 — no reference frequency, anywhere
// ══════════════════════════════════════════════════════════════════

describe("ac-10 — no reference-frequency metric is computed or exposed", () => {
  it("no hit carries a reference/citation count field", async () => {
    tagAc(AC(10));
    const hits = await searchMemex(memexId, "grobnitz", { disableVector: true });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      const keys = Object.keys(hit);
      for (const k of keys) {
        expect(k).not.toMatch(/reference|citation|refCount|citedBy|inbound/i);
      }
    }
  });

  it("the rendered label carries no count-shaped authority signal", async () => {
    tagAc(AC(10));
    const hits = await searchMemex(memexId, "grobnitz", { disableVector: true });
    const out = formatSearchResults("grobnitz", hits, { now: NOW });
    for (const heading of out.split("\n").filter((l) => l.startsWith("### "))) {
      expect(heading).not.toMatch(/\d+\s*(references?|citations?|mentions?|links?)/i);
    }
  });

  it("the retrieval path adds NO counting query — the cost dec-7 refused to pay", () => {
    tagAc(AC(10));
    // The reason reference frequency was dropped is cost on the hot retrieval path.
    // Assert the source carries no such aggregate, so a future "cheap little count"
    // trips this rather than quietly landing.
    const strip = (rel: string) =>
      readFileSync(resolve(__dirname, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
        .join("\n");
    for (const rel of [
      "memex-search/retrieval.ts",
      "memex-search/ranking.ts",
      "memex-search/formatting.ts",
    ]) {
      const src = strip(rel);
      expect(src).not.toMatch(/reference_count|citation_count|refCount|citedBy/i);
      expect(src).not.toMatch(/COUNT\(\*\)\s+AS\s+(reference|citation|mention)/i);
    }
  });

  it("recency is read off a timestamp the row already selects — no extra round trip", () => {
    tagAc(AC(10));
    // dec-7's whole argument for recency-yes / references-no is that recency is
    // cheap: it rides a column the tier already reads. `resolved_at` is added to the
    // existing decision SELECT rather than fetched per hit (std-39 cl-5).
    const src = readFileSync(resolve(__dirname, "memex-search/retrieval.ts"), "utf8");
    expect(src).toContain("dec.resolved_at AS resolved_at");
    // And the supersession enrichment is ONE batched query over the capped set, not
    // per-hit — the same posture as attachOpenComments.
    expect(src).toContain("export async function attachSupersession");
    const fn = src.slice(src.indexOf("export async function attachSupersession"));
    const body = fn.slice(0, fn.indexOf("export async function runDecisionFts"));
    expect((body.match(/db\.execute/g) ?? []).length).toBe(1);
  });
});
