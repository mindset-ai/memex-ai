// spec-525 t-8 — the protocol we TEACH matches the protocol we SHIP.
//
// THE DEFECT THIS CLOSES. `/api/test-events/batch` shipped with spec-489, and
// `@memex-ai-ac/vitest@0.3.0` buffers per test file and flushes one request. But every
// surface that teaches the protocol still described one POST per tagged test — the
// bootstrap topic (the canonical instruction for any stack without an official helper,
// which per std-22 is the expected case and per std-48 is already reality for Dart), its
// sibling `ac-emission` topic, and `docs/examples/README.md`. Zero occurrences of batch /
// buffer / flush across all three, verified 2026-08-11.
//
// So the shape that caused the 2026-08-11 connection-pool exhaustion was not merely
// tolerated in old clients; it was being TAUGHT to new ones, permanently, to readers who
// will never have a version to bump. A client hand-rolled from that documentation emits
// one request per test forever.
//
// AND THE ONE THAT PROTECTS THE SERVER FROM ITS OWN READERS. The topics mentioned neither
// `retry` nor `429`, so spec-525's admission gate was safe only by OMISSION — a hand-roller
// who added a retry loop of their own would turn every shed into an amplification at the
// exact moment the instance is saturated. Worse, an emitter that treats a 429 as
// "route absent" would fan one refused batch out into hundreds of single POSTs. Both rules
// are now stated, and asserted here.
//
// A reader opens ONE of these surfaces, not all three — which is why ac-6 requires them to
// agree rather than requiring any single one to be right.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { fetchTopic } from "../services/guidance.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525";
const AC_PROTOCOL = `${SPEC}/acs/ac-5`; // the bootstrap protocol teaches the batched shape
const AC_AGREE = `${SPEC}/acs/ac-6`; // all three teaching surfaces agree

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const EXAMPLES_README = readFileSync(
  join(REPO_ROOT, "docs", "examples", "README.md"),
  "utf-8",
);

describe("spec-525 ac-5: the bootstrap protocol teaches the batched shape", () => {
  it("names the /batch endpoint and its bounds", async () => {
    tagAc(AC_PROTOCOL);
    const { body } = await fetchTopic("ac-emission-bootstrap");
    expect(body).toMatch(/\/api\/test-events\/batch/);
    // The batch envelope and the server's hard cap, so a hand-roller sends a shape the
    // server accepts and splits rather than being 400'd on an oversized buffer.
    expect(body).toMatch(/"events"/);
    expect(body).toMatch(/500/);
  });

  it("tells the reader to buffer and flush per test file, not to post per test", async () => {
    tagAc(AC_PROTOCOL);
    const { body } = await fetchTopic("ac-emission-bootstrap");
    expect(body).toMatch(/buffer/i);
    expect(body).toMatch(/flush/i);
    expect(body).toMatch(/one request per test FILE/i);
  });

  it("specifies the fallback, and bounds it", async () => {
    tagAc(AC_PROTOCOL);
    const { body } = await fetchTopic("ac-emission-bootstrap");
    // 404/405 is the ONLY route-absent signal. Naming the codes matters: an emitter that
    // falls back on any non-2xx amplifies a 429 into hundreds of single requests.
    expect(body).toMatch(/404/);
    expect(body).toMatch(/405/);
    // …and the fallback itself must not become the unbounded fan-out batching removed.
    expect(body).toMatch(/in flight/i);
    expect(body).toMatch(/deadline/i);
  });

  it("states that a 429 is dropped and never retried", async () => {
    tagAc(AC_PROTOCOL);
    const { body } = await fetchTopic("ac-emission-bootstrap");
    expect(body).toMatch(/429/);
    expect(body).toMatch(/never retry/i);
    // The reason, not just the rule — a rule without its reason gets optimised away.
    expect(body).toMatch(/shedding|saturated/i);
  });
});

describe("spec-525 ac-6: every surface that teaches the protocol agrees", () => {
  const mentionsBatching = (text: string) => /batch/i.test(text);

  it("the bootstrap topic describes batching", async () => {
    tagAc(AC_AGREE);
    const { body } = await fetchTopic("ac-emission-bootstrap");
    expect(mentionsBatching(body)).toBe(true);
  });

  it("the sibling ac-emission topic describes batching", async () => {
    tagAc(AC_AGREE);
    // The surface an agent WITH the official helper reads. It was silent on batching too,
    // so a reader here learned nothing about the shape their helper already sends.
    const { body } = await fetchTopic("ac-emission");
    expect(mentionsBatching(body)).toBe(true);
    expect(body).toMatch(/never retried|never retry/i);
  });

  it("docs/examples/README.md describes batching", () => {
    tagAc(AC_AGREE);
    expect(mentionsBatching(EXAMPLES_README)).toBe(true);
  });

  it("no surface still teaches one POST per tagged test", async () => {
    tagAc(AC_AGREE);
    const bootstrap = (await fetchTopic("ac-emission-bootstrap")).body;
    const emission = (await fetchTopic("ac-emission")).body;
    // The exact phrasing docs/examples/README.md carried until this Spec.
    for (const surface of [bootstrap, emission, EXAMPLES_README]) {
      expect(surface).not.toMatch(/POSTs? .{0,40}after every tagged test/i);
    }
  });

  it("docs/examples/README.md no longer documents a file that does not exist", () => {
    tagAc(AC_AGREE);
    // It described copying `ac-emit-vitest.ts` into your test setup and explained "why a
    // file, not a package (yet)" — while the package was published and the file deleted.
    // The bootstrap topic points hand-rollers at this directory to check for an official
    // helper, so a stale answer here misroutes exactly the reader Half B is written for.
    expect(EXAMPLES_README).not.toMatch(/Copy this file into your test setup/i);
    expect(EXAMPLES_README).not.toMatch(/Why a file, not a package/i);
    expect(EXAMPLES_README).toMatch(/@memex-ai-ac\/vitest/);
    // std-1 vocabulary: refs are specs/spec-N/acs/ac-N. The page still used the retired
    // `briefs/b-N/ac-M` form in its usage example.
    expect(EXAMPLES_README).not.toMatch(/briefs\/b-\d/);
  });
});
