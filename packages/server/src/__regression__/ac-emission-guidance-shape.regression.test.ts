// b-90 ac-6 — the `ac-emission` guidance topic leads with the namespace-
// routing mental model before describing the env-var override, and contains
// an explicit anti-example naming the "set MEMEX_TEST_EVENTS_URL to localhost
// defensively" mistake.
//
// This is the body-shape that an agent reads when calling
// `get_information(topic='ac-emission')`. The b-68 incident showed that
// when the override was named more memorably than the routing map, agents
// reached for the override. Re-ordering the body puts the mental model in
// the position an agent is most likely to absorb.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc, deriveEventsUrl } from "@memex-ai-ac/vitest";

const TOPIC = join(
  __dirname,
  "..",
  "..",
  "src",
  "guidance",
  "ac-emission.json",
);

const topic = JSON.parse(readFileSync(TOPIC, "utf-8")) as {
  title: string;
  when_to_read: string;
  body: string;
};

describe("b-90 ac-6: ac-emission guidance topic body shape", () => {
  it("body leads with the namespace-routing mental model", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    // The first ~500 chars should establish "the ref IS the routing
    // instruction" mental model before any mechanism / override discussion.
    const opening = topic.body.slice(0, 500);
    expect(opening).toMatch(/namespace/i);
    expect(opening).toMatch(/routing/i);
  });

  it("body explicitly states 'the ref's namespace IS the routing instruction'", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(topic.body).toMatch(
      /namespace\s+IS\s+the\s+routing\s+instruction/i,
    );
  });

  it("body mentions MEMEX_TEST_EVENTS_URL AFTER the routing model is established", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    const routingIdx = topic.body.search(/namespace\s+IS\s+the\s+routing\s+instruction/i);
    const overrideIdx = topic.body.search(/MEMEX_TEST_EVENTS_URL/);
    expect(routingIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeGreaterThan(routingIdx);
  });

  it("body frames the override as 'almost never needed'", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(topic.body).toMatch(/almost\s+never/i);
  });

  it("body contains an anti-example callout naming the localhost-as-safe mistake", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    // The literal mistake shape from b-68.
    expect(topic.body).toMatch(
      /MEMEX_TEST_EVENTS_URL=http:\/\/localhost:8080[^\n]*be\s+safe/i,
    );
  });

  it("body explains that the override defeats the default safety", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(topic.body).toMatch(/default\s+routing\s+IS\s+the\s+safety/i);
  });

  it("body still describes the wire format (POST /api/test-events)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(topic.body).toMatch(/POST.*\/api\/test-events|\/api\/test-events/);
    expect(topic.body).toMatch(/ac_uid/);
    expect(topic.body).toMatch(/status/);
  });
});

// spec-129 — the topic teaches the AI coding agent the emission-key flow. This is the
// load-bearing channel: the agent seeds a codebase with emission via get_information, NOT
// the 2KB-capped session-init instructions (see guidance/README.md). If this guidance
// silently drops, an agent hits 401s and flails — the exact failure the library exists to
// prevent. These tests pin it in place.
describe("spec-129: ac-emission guidance covers the emission-key flow", () => {
  it("documents MEMEX_EMIT_KEY and the Bearer transport", () => {
    expect(topic.body).toMatch(/MEMEX_EMIT_KEY/);
    expect(topic.body).toMatch(/Authorization:\s*Bearer/i);
  });

  it("tells the agent a key is REQUIRED and a missing key means emissions silently don't land", () => {
    expect(topic.body).toMatch(/required/i);
    expect(topic.body).toMatch(/401/);
    expect(topic.body).toMatch(/silently|never\s+fails?/i);
  });

  it("documents agent self-provisioning (provision_ac_emission) while keeping CI keys human-minted [spec-234]", () => {
    // spec-234 reversed the old "an agent cannot mint a key" instruction: an agent now
    // provisions its own short-lived key via provision_ac_emission; only long-lived CI
    // keys are human-minted in Settings → Emission Keys.
    expect(topic.body).toMatch(/provision_ac_emission/);
    expect(topic.body).not.toMatch(/must NOT and CANNOT mint/i);
    expect(topic.body).toMatch(/Emission Keys/); // CI path still points at Settings
  });

  it("does not regress the routing mental model (still leads the body)", () => {
    // The key flow is additive — it must not displace the namespace-routing model that
    // the b-90 tests above guard. Belt-and-braces: the key section comes AFTER it.
    const routingIdx = topic.body.search(/namespace\s+IS\s+the\s+routing\s+instruction/i);
    const keyIdx = topic.body.search(/MEMEX_EMIT_KEY/);
    expect(routingIdx).toBeGreaterThanOrEqual(0);
    expect(keyIdx).toBeGreaterThan(routingIdx);
  });
});

// spec-129 t-9 — the daisy-chain: ac-emission points to a focused bootstrap topic for
// codebases with no official helper, and that topic must be sufficient to hand-roll a
// correct emitter. Pins both the pointer and the bootstrap topic's load-bearing content.
const BOOTSTRAP = join(
  __dirname,
  "..",
  "..",
  "src",
  "guidance",
  "ac-emission-bootstrap.json",
);
const bootstrap = JSON.parse(readFileSync(BOOTSTRAP, "utf-8")) as {
  title: string;
  when_to_read: string;
  body: string;
};

describe("spec-129 t-9: bootstrap daisy-chain", () => {
  it("ac-emission points to the ac-emission-bootstrap topic for non-npm stacks", () => {
    expect(topic.body).toMatch(/ac-emission-bootstrap/);
    expect(topic.body).toMatch(/get_information\(topic='ac-emission-bootstrap'\)/);
  });

  it("bootstrap topic specifies the wire format (required fields)", () => {
    for (const f of ["ac_uid", "status", "test_identifier", "duration_ms"]) {
      expect(bootstrap.body).toMatch(new RegExp(f));
    }
  });

  it("bootstrap topic specifies routing hosts + the no-localhost rule", () => {
    expect(bootstrap.body).toMatch(/int\.memex\.ai/);
    expect(bootstrap.body).toMatch(/memex\.ai/);
    expect(bootstrap.body).toMatch(/localhost/i);
  });

  it("bootstrap topic specifies Bearer auth + MEMEX_EMIT_KEY", () => {
    expect(bootstrap.body).toMatch(/Authorization:\s*Bearer/i);
    expect(bootstrap.body).toMatch(/MEMEX_EMIT_KEY/);
  });

  it("bootstrap topic states the never-throw + emit-on-pass-and-fail rules", () => {
    expect(bootstrap.body).toMatch(/never\s+throw|swallow/i);
    expect(bootstrap.body).toMatch(/pass.*fail|fail.*pass/i);
  });

  it("bootstrap topic tells porters to prefer the official package", () => {
    expect(bootstrap.body).toMatch(/prefer.*official|official.*helper/i);
  });
});

// spec-90 dec-7 (B1) — the guidance MUST stay in lockstep with the implemented
// routing reality: unknown namespaces default to the SaaS host (memex.ai), they
// are NOT skipped. The first assertion pins the actual deriveEventsUrl behaviour;
// the rest pin the two get_information topics to that same reality. If the code
// changes, the doc assertions force the docs to change with it, and vice-versa.
describe("spec-90 dec-7: emission guidance is locked to the multi-tenant routing reality", () => {
  const UNKNOWN_NS_DEST = "https://memex.ai/api/test-events";

  it("deriveEventsUrl actually defaults an unknown namespace to memex.ai", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-2");
    expect(deriveEventsUrl("a-customer/their-mx/specs/spec-1/acs/ac-1")).toBe(
      UNKNOWN_NS_DEST,
    );
  });

  it("ac-emission topic documents the memex.ai default and no longer says it skips", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(topic.body).toMatch(/defaults? to the SaaS host `?https:\/\/memex\.ai/i);
    expect(topic.body).not.toMatch(/warns once and skips the emission/i);
  });

  it("ac-emission-bootstrap topic documents the memex.ai default for unknown namespaces", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(bootstrap.body).toMatch(/default to the SaaS host `?https:\/\/memex\.ai/i);
    expect(bootstrap.body).toMatch(
      /defaults unknown namespaces to `?https:\/\/memex\.ai/i,
    );
  });

  it("bootstrap no longer instructs skipping unmapped namespaces", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-90/acs/ac-6");
    expect(bootstrap.body).not.toMatch(/skip the emission/i);
    expect(bootstrap.body).not.toMatch(/skips unknown namespaces/i);
  });
});

// spec-358 — the inbound `hidden` flag is no longer honoured and the emitter no
// longer sends it. Both emitter-facing get_information topics must be scrubbed
// of `hidden` / `MEMEX_HIDDEN` so no agent reads it as something an emitter can
// set. This guards ac-4 (the bootstrap behavioural-contract checklist included).
describe("spec-358: emitter-facing guidance is scrubbed of the hidden flag", () => {
  it("ac-emission topic mentions neither `hidden` nor MEMEX_HIDDEN [spec-358 ac-4]", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-358/acs/ac-4");
    expect(topic.body).not.toMatch(/hidden/i);
    expect(topic.body).not.toMatch(/MEMEX_HIDDEN/);
  });

  it("ac-emission-bootstrap topic (incl. its behavioural-contract checklist) mentions neither `hidden` nor MEMEX_HIDDEN [spec-358 ac-4]", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-358/acs/ac-4");
    expect(bootstrap.body).not.toMatch(/hidden/i);
    expect(bootstrap.body).not.toMatch(/MEMEX_HIDDEN/);
  });
});

// spec-404 — emission is the celebrated default; the MEMEX_EMIT off switch is a
// NARROW can't-emit escape, NOT routine developer-laptop hygiene. The earlier
// "typically developer laptops" framing actively taught agents to silence the
// live board on the exact surface where they work, and the b-90 category-error
// anti-example only ever covered the MEMEX_TEST_EVENTS_URL override, never the
// MEMEX_EMIT off switch. These assertions pin the reframed shape across the
// agent-facing topic AND the emitter README, guard against over-scrubbing the
// bootstrap off-switch *contract* (which must stay — a hand-rolled emitter MUST
// honour the off switch), and against any change to the gate in emit.ts.
const README = join(__dirname, "..", "..", "..", "ac-emit-vitest", "README.md");
const readme = readFileSync(README, "utf-8");

const EMIT_TS = join(
  __dirname,
  "..",
  "..",
  "..",
  "ac-emit-vitest",
  "src",
  "emit.ts",
);
const emitTs = readFileSync(EMIT_TS, "utf-8");

// Bound a region to JUST the MEMEX_EMIT section (heading → next ##/### heading)
// so the category-error assertions cannot be satisfied by the unrelated
// MEMEX_TEST_EVENTS_URL anti-example further down the body.
function memexEmitSection(body: string): string {
  const start = body.search(/###\s+`?MEMEX_EMIT`?/);
  if (start < 0) return "";
  const rest = body.slice(start + 1);
  const nextHeading = rest.search(/\n#{2,3}\s/);
  return nextHeading >= 0
    ? body.slice(start, start + 1 + nextHeading)
    : body.slice(start);
}

describe("spec-404: emission is the celebrated default, MEMEX_EMIT is a narrow escape", () => {
  it("ac-emission topic no longer frames MEMEX_EMIT as developer-laptop hygiene", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-6");
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-2");
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-12");
    expect(topic.body).not.toMatch(/developer laptops/i);
  });

  it("ac-emission topic leads the MEMEX_EMIT section with emission-as-the-default", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-6");
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-1");
    const region = memexEmitSection(topic.body);
    expect(region).toMatch(/Emitting is the point/i);
    expect(region).toMatch(/SHOULD emit/);
    // the encouraging lead precedes the off-value mechanics within the section
    expect(region.search(/Emitting is the point/i)).toBeLessThan(
      region.search(/Accepted off-values/i),
    );
  });

  it("ac-emission topic names the 'to be safe' MEMEX_EMIT move as the same category error, default = let it land", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-8");
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-3");
    const region = memexEmitSection(topic.body);
    expect(region).toMatch(/to be safe/i);
    expect(region).toMatch(/spam.*prod/i);
    expect(region).toMatch(/same category error/i);
    expect(region).toMatch(/let the emission land/i);
  });

  it("ac-emission topic preserves the MEMEX_EMIT mechanics verbatim", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-7");
    expect(topic.body).toMatch(/`false`, `0`, `no`, `off`/);
    expect(topic.body).toMatch(/zero HTTP requests/);
    expect(topic.body).toMatch(/Default and any other value is `true`/);
  });

  it("ac-emission topic retains the localhost MEMEX_TEST_EVENTS_URL anti-example (b-90 intact)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-9");
    expect(topic.body).toMatch(
      /MEMEX_TEST_EVENTS_URL=http:\/\/localhost:8080[^\n]*be\s+safe/i,
    );
    expect(topic.body).toMatch(/default\s+routing\s+IS\s+the\s+safety/i);
  });

  it("emitter README mirrors the reframe (no developer-laptop hygiene framing)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-10");
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-4");
    expect(readme).not.toMatch(/developer laptops/i);
    expect(readme).toMatch(/MEMEX_EMIT=false/);
    expect(readme).toMatch(/`false`, `0`, `no`, `off`/);
  });

  it("bootstrap topic RETAINS the off-switch behavioural contract (not over-scrubbed)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-11");
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-4");
    expect(bootstrap.body).toMatch(/MEMEX_EMIT/);
    expect(bootstrap.body).toMatch(/Respect the off switch/i);
    expect(bootstrap.body).toMatch(/Honours `?MEMEX_EMIT`? off/i);
  });

  it("emit.ts still implements the MEMEX_EMIT gate (runtime mechanism unchanged)", () => {
    tagAc("mindset-prod/memex-building-itself/specs/spec-404/acs/ac-5");
    expect(emitTs).toMatch(/MEMEX_EMIT\b/);
    expect(emitTs).toMatch(/false/);
    expect(emitTs).toMatch(/off/);
  });
});
