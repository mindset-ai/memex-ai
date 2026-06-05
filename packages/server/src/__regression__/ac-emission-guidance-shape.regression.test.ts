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
import { tagAc } from "@memex-ai-ac/vitest";

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
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
    // The first ~500 chars should establish "the ref IS the routing
    // instruction" mental model before any mechanism / override discussion.
    const opening = topic.body.slice(0, 500);
    expect(opening).toMatch(/namespace/i);
    expect(opening).toMatch(/routing/i);
  });

  it("body explicitly states 'the ref's namespace IS the routing instruction'", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
    expect(topic.body).toMatch(
      /namespace\s+IS\s+the\s+routing\s+instruction/i,
    );
  });

  it("body mentions MEMEX_TEST_EVENTS_URL AFTER the routing model is established", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
    const routingIdx = topic.body.search(/namespace\s+IS\s+the\s+routing\s+instruction/i);
    const overrideIdx = topic.body.search(/MEMEX_TEST_EVENTS_URL/);
    expect(routingIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeGreaterThanOrEqual(0);
    expect(overrideIdx).toBeGreaterThan(routingIdx);
  });

  it("body frames the override as 'almost never needed'", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
    expect(topic.body).toMatch(/almost\s+never/i);
  });

  it("body contains an anti-example callout naming the localhost-as-safe mistake", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
    // The literal mistake shape from b-68.
    expect(topic.body).toMatch(
      /MEMEX_TEST_EVENTS_URL=http:\/\/localhost:8080[^\n]*be\s+safe/i,
    );
  });

  it("body explains that the override defeats the default safety", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
    expect(topic.body).toMatch(/default\s+routing\s+IS\s+the\s+safety/i);
  });

  it("body still describes the wire format (POST /api/test-events)", () => {
    tagAc("mindset-prod/memex-building-itself/briefs/b-90/acs/ac-6");
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

  it("instructs the agent it cannot mint a key and must ask the human (settings → Emission Keys)", () => {
    expect(topic.body).toMatch(/cannot mint|must NOT.*mint|not.*mint/i);
    expect(topic.body).toMatch(/ask the human/i);
    expect(topic.body).toMatch(/Emission Keys/);
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
