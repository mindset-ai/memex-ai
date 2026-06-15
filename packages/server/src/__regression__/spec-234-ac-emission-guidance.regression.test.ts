// spec-234 t-4 — the ac-emission guidance documents agent self-provisioning.
//
// The old contract ("an agent cannot mint a key, ask a human") is replaced: an agent now
// calls provision_ac_emission for a short-lived key; only long-lived CI keys stay
// human-minted. The guidance stays on the std-22 portable surface (no hardcoded repo
// paths, runner/build tokens, or std-N literals in the provisioning section).

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { fetchTopic } from "../services/guidance.js";

const M = "mindset-prod/memex-building-itself/specs/spec-234/acs";
const AC_9 = `${M}/ac-9`; // SCOPE: guidance reflects agent may provision; "cannot mint" gone
const AC_21 = `${M}/ac-21`; // IMPL: documents provision_ac_emission; CI still human-minted; portable

describe("spec-234 — ac-emission guidance reflects agent self-provisioning", () => {
  it("ac-emission documents provision_ac_emission and drops the 'cannot mint' instruction [ac-9][ac-21]", async () => {
    tagAc(AC_9);
    tagAc(AC_21);
    const topic = await fetchTopic("ac-emission"); // throws if the JSON no longer parses
    expect(topic.body).toMatch(/provision_ac_emission/);
    expect(topic.body).not.toMatch(/must NOT and CANNOT mint/i);
    expect(topic.body).not.toMatch(/cannot mint emission keys/i);
    // CI / long-lived keys are still routed to a human in Settings → Emission Keys.
    expect(topic.body).toMatch(/Settings → Emission Keys/);
    expect(topic.body).toMatch(/human/i);
  });

  it("the bootstrap topic also points at provision_ac_emission for getting a key [ac-21]", async () => {
    tagAc(AC_21);
    const topic = await fetchTopic("ac-emission-bootstrap");
    expect(topic.body).toMatch(/provision_ac_emission/);
    expect(topic.body).not.toMatch(/You CANNOT mint a key yourself: a human/i);
  });

  it("the provisioning section is portable — no std-N literal or runner/build token [ac-21]", async () => {
    tagAc(AC_21);
    const { body } = await fetchTopic("ac-emission");
    // Isolate the section we authored (from its heading to the next H2).
    const start = body.indexOf("### Getting a key");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = body.slice(start);
    const end = rest.indexOf("\n## ");
    const section = end >= 0 ? rest.slice(0, end) : rest;
    // std-22: portable text must not hardcode a Standard handle or a specific
    // runner / build / package-manager token.
    expect(section).not.toMatch(/std-\d+/i);
    expect(section).not.toMatch(/\b(vitest|jest|pytest|pnpm|npm run|make test)\b/i);
  });
});
