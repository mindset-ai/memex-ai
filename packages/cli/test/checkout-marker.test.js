import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeMarker,
  readMarker,
  clearMarker,
  isExpired,
  resolveActiveClaim,
  decideEditAction,
  parseSpecRef,
  DEFAULT_TTL_MS,
} from "../plugin/lib/checkout-marker.js";

// spec-371 t-5 — the client-side marker logic (the privacy gate + nudge), pure.
const NS = "mindset-prod/memex-building-itself/specs/spec-371/acs";
const AC_1 = `${NS}/ac-1`; // claim writes the local thread→spec marker
const AC_2 = `${NS}/ac-2`; // no marker → zero network calls
const AC_4 = `${NS}/ac-4`; // unclaim clears; TTL releases; new claim supersedes
const AC_5 = `${NS}/ac-5`; // one nudge then silence, nothing leaves until claimed

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memex-ck-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const o = (extra = {}) => ({ dir, ...extra });

describe("checkout-marker (spec-371 ac-1, ac-2, ac-4, ac-5)", () => {
  it("a claim writes a local marker keyed by the thread session, readable back (ac-1)", () => {
    tagAc(AC_1);
    writeMarker("sess-1", { memex: "ns/m", spec: "spec-371" }, o({ now: 1000 }));
    expect(readMarker("sess-1", o())).toEqual({ memex: "ns/m", spec: "spec-371", ts: 1000 });
    // a different thread is independent (parallel sessions don't collide).
    expect(readMarker("sess-2", o())).toBeNull();
  });

  it("parseSpecRef extracts the (memex, spec) the marker watches; ignores non-spec refs (ac-1)", () => {
    tagAc(AC_1);
    expect(parseSpecRef("ns/m/specs/spec-371")).toEqual({
      memex: "ns/m",
      spec: "spec-371",
      ref: "ns/m/specs/spec-371",
    });
    expect(parseSpecRef("ns/m/decisions/dec-1")).toBeNull();
    expect(parseSpecRef("garbage")).toBeNull();
  });

  it("unclaim clears, TTL expiry releases, and a new claim supersedes the prior one (ac-4)", () => {
    tagAc(AC_4);
    writeMarker("s", { memex: "ns/m", spec: "spec-1" }, o({ now: 0 }));
    // supersede: a new claim overwrites the binding rather than stacking.
    writeMarker("s", { memex: "ns/m", spec: "spec-2" }, o({ now: 10 }));
    expect(readMarker("s", o()).spec).toBe("spec-2");
    // TTL: a stale marker is treated as released.
    expect(isExpired({ ts: 0 }, 100, 1000)).toBe(true);
    expect(resolveActiveClaim("s", o({ ttlMs: 5, now: 1000 }))).toBeNull();
    // explicit unclaim removes it.
    clearMarker("s", o());
    expect(readMarker("s", o())).toBeNull();
  });

  it("an edit with NO claim never phones home: one nudge, then silence (ac-2, ac-5)", () => {
    tagAc(AC_2);
    tagAc(AC_5);
    const first = decideEditAction("u", o());
    expect(first.action).toBe("nudge");
    const second = decideEditAction("u", o());
    expect(second.action).toBe("silent");
    // neither path leaves the machine.
    expect([first.action, second.action]).not.toContain("phone-home");
  });

  it("an edit phones home ONLY with a fresh claim; an expired claim falls back to a nudge (ac-2)", () => {
    tagAc(AC_2);
    writeMarker("c", { memex: "ns/m", spec: "spec-371" }, o({ now: 1000 }));
    const d = decideEditAction("c", o({ now: 1001 }));
    expect(d.action).toBe("phone-home");
    expect(d.claim).toMatchObject({ memex: "ns/m", spec: "spec-371", ref: "ns/m/specs/spec-371" });

    // an EXPIRED claim does not phone home — treated as unclaimed.
    writeMarker("c2", { memex: "ns/m", spec: "spec-371" }, o({ now: 0 }));
    expect(decideEditAction("c2", o({ now: DEFAULT_TTL_MS + 1 })).action).not.toBe("phone-home");
  });
});
