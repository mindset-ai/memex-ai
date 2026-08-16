// spec-525 t-11 / ac-21 — a shed leaves a record readable from OUTSIDE the process.
//
// THE BUG THIS REPRODUCES. On 2026-08-16 the shadow window had been running in prod for
// two days and had recorded nothing anyone could read. The chain, each link verified
// against the running system rather than assumed:
//
//   recordEmissionShed  → `if (!config.enabled) return;`
//   config.enabled      → requires OTEL_EXPORTER_OTLP_ENDPOINT
//   prod revision       → memex-api-00131-zk5 carries 40 env vars; that one is ABSENT
//   int revision        → absent as well
//   EmissionGate.wouldShed → in-process getter, exposed by no route, on instances that recycle
//
// So spec-525 t-10 — "read the counter by cause, set the wait interval and waiter bound
// from that data" — had no input, and spec-532 was holding spec-520 back to protect a
// measurement that was not being taken.
//
// WHAT THIS IS NOT. It is NOT ac-13. ac-13 says in its own words that "a log line alone
// fails this", and it is right: the 2026-08-11 incident had `writesFailed: 251` sitting
// in the logs and was still found by a person saying the app was broken. ac-13 is about
// an ALERTABLE metric and stays unsatisfied until an OTLP endpoint exists. This AC is
// about a READABLE measurement — the one-time read t-10 needs, which is ac-2's
// requirement that the ceiling and wait interval come from shadow data rather than being
// chosen in advance. Closing ac-21 must never be used to close ac-13.
//
// WHY JSON AND NOT A PRETTY LINE. Cloud Run ships stdout to Cloud Logging, which parses a
// line that is ENTIRELY valid JSON into `jsonPayload` and makes its fields queryable and
// aggregatable — across instances and across restarts, which is exactly what the
// in-process counter could not do. A `[emission-gate] shed ...` text line in the repo's
// usual style would be human-readable and NOT aggregatable by cause, so it would leave
// t-10 hand-counting log entries. Hence the departure from the `console.log("[domain] …")`
// convention used in test-events.ts, and hence the JSON.parse assertions below: a test
// that merely checked "something was logged" would pass against an unparseable line and
// prove nothing about the property that matters.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { logEmissionShed } from "../observability/emission-shed-log.js";
import {
  emissionGate,
  __setEmissionGateForTest,
} from "./emission-admission.js";

const AC_READABLE = "mindset-prod/memex-building-itself/specs/spec-525/acs/ac-21";

let lines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

/** Every stdout line this test captured, parsed. Non-JSON lines fail the parse on purpose. */
const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  lines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  // [per std-37] cl-5: restore what the test replaced — console is the very thing this
  // file observes, and a leaked stub would silently swallow a sibling's output.
  logSpy.mockRestore();
  vi.unstubAllEnvs();
  __setEmissionGateForTest(null);
});

describe("spec-525 ac-21: a shed writes one queryable JSON record to stdout", () => {
  it("writes exactly one line, and it parses as JSON", () => {
    tagAc(AC_READABLE);
    logEmissionShed({
      events: 1,
      cause: "key_slice_full",
      waited: false,
      mode: "shadow",
    });

    expect(lines).toHaveLength(1);
    // The assertion that carries the whole point. Cloud Logging only lifts fields into
    // `jsonPayload` when the ENTIRE line is valid JSON; a prefix like "[emission-gate] "
    // would leave it an opaque textPayload and un-aggregatable.
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it("carries a stable marker so the record can be filtered from everything else on stdout", () => {
    tagAc(AC_READABLE);
    logEmissionShed({
      events: 1,
      cause: "key_slice_full",
      waited: false,
      mode: "shadow",
    });
    // Without this, reading the window means grepping for a shape rather than a name.
    expect(parsed()[0].event).toBe("emission_shed");
  });

  it("carries cause and waited as DISTINCT fields — the two axes t-10 must split on", () => {
    tagAc(AC_READABLE);
    logEmissionShed({ events: 4, cause: "key_slice_full", waited: false, mode: "shadow" });
    logEmissionShed({
      events: 7,
      cause: "instance_ceiling_full",
      waited: true,
      mode: "shadow",
    });

    const [first, second] = parsed();
    expect(first.cause).toBe("key_slice_full");
    expect(first.waited).toBe(false);
    expect(second.cause).toBe("instance_ceiling_full");
    expect(second.waited).toBe(true);
    // `waited` separates opposite operator responses: refused AFTER waiting is accidental
    // overload (holding the slot is right); refused WITHOUT waiting is a flood (refusing
    // instantly preserves capacity). Collapsing them would make the window unreadable.
  });

  it("counts EMISSIONS, not requests — a shed batch of 500 must not read as 1", () => {
    tagAc(AC_READABLE);
    logEmissionShed({
      events: 500,
      cause: "instance_ceiling_full",
      waited: true,
      mode: "shadow",
    });
    const rec = parsed()[0];
    // Same unit as ac-13's counter: emitBatch drops the WHOLE bucket on a 429 with no
    // fallback, so one refused request can destroy 500 verification results.
    expect(rec.events).toBe(500);
    expect(rec.requests).toBe(1);
  });

  it("carries the mode, so a shadow would-be shed is never mistaken for a real refusal", () => {
    tagAc(AC_READABLE);
    logEmissionShed({ events: 1, cause: "key_slice_full", waited: false, mode: "shadow" });
    logEmissionShed({
      events: 1,
      cause: "key_slice_full",
      waited: false,
      mode: "enforcing",
    });

    const [shadowRec, enforcingRec] = parsed();
    expect(shadowRec.mode).toBe("shadow");
    expect(enforcingRec.mode).toBe("enforcing");
    // During the window every record is a COUNTERFACTUAL — nothing was actually refused.
    // A reader who cannot tell the two apart would report the window's would-be sheds as
    // real data loss, which is the opposite of what shadow mode means.
  });

  it("marks a real refusal at a higher severity than a counterfactual one", () => {
    tagAc(AC_READABLE);
    logEmissionShed({ events: 1, cause: "key_slice_full", waited: false, mode: "shadow" });
    logEmissionShed({
      events: 1,
      cause: "key_slice_full",
      waited: false,
      mode: "enforcing",
    });

    const [shadowRec, enforcingRec] = parsed();
    // Cloud Logging reads `severity` out of a JSON payload, so this is a free filter
    // rather than decoration. It is NOT an alert — see the ac-13 note at the top.
    expect(shadowRec.severity).toBe("INFO");
    expect(enforcingRec.severity).toBe("WARNING");
  });

  it("NEVER writes the credential — not the token, not a hash of it", () => {
    tagAc(AC_READABLE);
    logEmissionShed({ events: 1, cause: "key_slice_full", waited: false, mode: "shadow" });
    // The gate runs BEFORE authentication on a public route, so the presented token is an
    // unverified caller-controlled secret. ac-14 forbids it as a metric label for
    // cardinality reasons; here the reason is stronger — logs are retained and widely
    // readable, so a credential written once is a credential leaked.
    expect(Object.keys(parsed()[0]).sort()).toEqual(
      ["cause", "event", "events", "mode", "requests", "severity", "waited"].sort(),
    );
  });
});

describe("spec-525 ac-21: the record is WIRED to the gate the server actually runs", () => {
  it("a shed on the process-wide gate produces the record — not just a callable function", () => {
    tagAc(AC_READABLE);
    // This is the assertion that would have caught the original bug. A log helper that
    // exists but is never reached from `emissionGate()`'s onShed hook leaves prod exactly
    // as silent as it was, and every content test above would still pass.
    vi.stubEnv("DB_POOL_MAX", "2"); // ceiling 1 — saturates in one acquire
    vi.stubEnv("MEMEX_EMISSION_GATE_MODE", "enforcing");
    __setEmissionGateForTest(null); // force a rebuild from the stubbed environment

    const g = emissionGate();
    expect(g.mode).toBe("enforcing");
    for (let i = 0; i < g.ceiling + 1; i++) g.tryAcquire("occupant", 1);
    g.tryAcquire("someone-else", 500);

    const sheds = parsed().filter((r) => r.event === "emission_shed");
    expect(sheds.length).toBeGreaterThanOrEqual(1);
    const last = sheds[sheds.length - 1];
    expect(last.events).toBe(500);
    expect(last.cause).toBe("instance_ceiling_full");
    expect(last.mode).toBe("enforcing");
  });
});
