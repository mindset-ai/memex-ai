// Hermetic unit test for the e2e AC-emission fixture (spec-391 ac-12).
//
// installAcEmission (packages/ui/e2e/helpers/emit-ac.ts) is the ergonomic
// wrapper that lets a Playwright journey declare the ACs each test covers and
// emit on pass/fail automatically — the EMISSION plumbing workstream B owns
// (journey bodies are D's). It is pure TS over `fetch` (no React/ui imports), so
// it is unit-testable here in the fast jsdom suite WITHOUT the Playwright
// runner: we feed a fake Playwright `test`, capture the registered afterEach,
// stub `globalThis.fetch`, and assert the BEHAVIOUR — the event is constructed
// and routed correctly. No external network side-effect is asserted (a real
// POST to memex.ai is fire-and-forget/best-effort and is NOT a test oracle).
//
// This replaces a non-hermetic Playwright spec that did a real POST and asserted
// nothing meaningful — that spec reddened the e2e shards. The fixture's wire
// format is the contract; this proves it deterministically on a cold run.

import { describe, it, expect, vi, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { installAcEmission, emitAcEvents } from "../../e2e/helpers/emit-ac.js";

const SPEC391 = "mindset-prod/memex-building-itself/specs/spec-391";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MEMEX_EMIT;
});

describe("installAcEmission e2e fixture (spec-391 ac-12)", () => {
  it("registers an afterEach that POSTs a test_event for a declared AC ref on pass", async () => {
    tagAc(`${SPEC391}/acs/ac-12`);

    let registered:
      | ((args: Record<string, unknown>, info: { title: string; status?: string; duration: number }) => unknown)
      | null = null;
    const fakeTest = {
      afterEach(fn: typeof registered) {
        registered = fn;
      },
    };

    const declaredRef = `${SPEC391}/acs/ac-12`;
    installAcEmission(fakeTest, "file:///x/journey-99.spec.ts", {
      "covers ac-12": [declaredRef],
    });
    expect(registered).not.toBeNull();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    await registered!({}, { title: "covers ac-12", status: "passed", duration: 12 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // mindset-prod → memex.ai (the default namespace routing IS the safety).
    expect(url).toBe("https://memex.ai/api/test-events");
    const body = JSON.parse(init.body as string);
    expect(body.ac_uid).toBe(declaredRef);
    expect(body.status).toBe("pass");
    expect(body.test_identifier).toContain("journey-99.spec.ts::covers ac-12");
  });

  it("emits a fail event when the test failed", async () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    let registered:
      | ((args: Record<string, unknown>, info: { title: string; status?: string; duration: number }) => unknown)
      | null = null;
    const fakeTest = { afterEach(fn: typeof registered) { registered = fn; } };
    installAcEmission(fakeTest, "file:///x/j.spec.ts", { "t": [`${SPEC391}/acs/ac-12`] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await registered!({}, { title: "t", status: "failed", duration: 3 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.status).toBe("fail");
  });

  it("emits nothing for a skipped test or a test with no declared ACs", async () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    let registered:
      | ((args: Record<string, unknown>, info: { title: string; status?: string; duration: number }) => unknown)
      | null = null;
    const fakeTest = { afterEach(fn: typeof registered) { registered = fn; } };
    installAcEmission(fakeTest, "file:///x/j.spec.ts", { "tagged test": [`${SPEC391}/acs/ac-12`] });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    await registered!({}, { title: "tagged test", status: "skipped", duration: 1 });
    await registered!({}, { title: "untagged title", status: "passed", duration: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws even if the network rejects (emission is best-effort)", async () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    let registered:
      | ((args: Record<string, unknown>, info: { title: string; status?: string; duration: number }) => unknown)
      | null = null;
    const fakeTest = { afterEach(fn: typeof registered) { registered = fn; } };
    installAcEmission(fakeTest, "file:///x/j.spec.ts", { "t": [`${SPEC391}/acs/ac-12`] });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    // Must resolve, not reject — emission must never fail a test run.
    await expect(
      registered!({}, { title: "t", status: "passed", duration: 1 }),
    ).resolves.toBeUndefined();
  });

  it("honours the MEMEX_EMIT off switch (emitAcEvents makes zero requests)", async () => {
    tagAc(`${SPEC391}/acs/ac-12`);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    process.env.MEMEX_EMIT = "false";
    await emitAcEvents([`${SPEC391}/acs/ac-12`], "pass", "id", 1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
