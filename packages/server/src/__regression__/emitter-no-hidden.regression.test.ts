// spec-358 ac-3 — the first-party emitter `@memex-ai-ac/vitest` no longer
// sends a `hidden` field, no longer reads MEMEX_HIDDEN, and no longer exposes a
// per-call `hidden` option in tagAc. The off switch (MEMEX_EMIT) is unaffected.
//
// This assertion lives in the SERVER package (not the emitter package) on
// purpose: the emitter package's own test run does not wire the prod-emission
// setup, so a tag placed there would never reach the verification badge. The
// server package emits, so tagging ac-3 here attributes the verification. We
// import the published emitter surface and assert the wire shape directly.

import { describe, it, expect, afterEach } from "vitest";
import * as emitter from "@memex-ai-ac/vitest";
import { buildPayload, isEmissionEnabled, tagAc } from "@memex-ai-ac/vitest";

const AC3 = "mindset-prod/memex-building-itself/specs/spec-358/acs/ac-3";

const base = {
  ac_uid: "mindset-prod/foo/specs/spec-1/acs/ac-1",
  status: "pass" as const,
  test_identifier: "probe.test.ts::it works",
  duration_ms: 1,
};

describe("spec-358 ac-3: the first-party emitter no longer carries the hidden flag", () => {
  afterEach(() => {
    delete process.env.MEMEX_HIDDEN;
  });

  it("buildPayload never includes a hidden field, even when MEMEX_HIDDEN is set", () => {
    tagAc(AC3);
    process.env.MEMEX_HIDDEN = "true"; // no longer read by the emitter
    const payload = buildPayload(base);
    expect("hidden" in payload).toBe(false);
  });

  it("buildPayload ignores a forced per-call hidden option (the option is gone from the type)", () => {
    tagAc(AC3);
    const payload = buildPayload({
      ...base,
      options: { hidden: true } as unknown as { metadata?: Record<string, string> },
    });
    expect("hidden" in payload).toBe(false);
  });

  it("the emitter exports no isHidden helper (the MEMEX_HIDDEN reader is gone)", () => {
    tagAc(AC3);
    expect((emitter as Record<string, unknown>).isHidden).toBeUndefined();
  });

  it("the MEMEX_EMIT off switch is unaffected — still gates emission", () => {
    tagAc(AC3);
    const saved = process.env.MEMEX_EMIT;
    try {
      process.env.MEMEX_EMIT = "off";
      expect(isEmissionEnabled()).toBe(false);
      process.env.MEMEX_EMIT = "true";
      expect(isEmissionEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.MEMEX_EMIT;
      else process.env.MEMEX_EMIT = saved;
    }
  });
});
