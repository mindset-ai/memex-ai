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
  decideEditSteer,
  decideMarkerAction,
  parseSpecRef,
  DEFAULT_TTL_MS,
  NAG_MIN_INTERVAL_MS,
} from "../plugin/lib/checkout-marker.js";

// spec-371 t-11 — the client-side marker logic (the privacy gate; no nudge), pure.
const NS = "mindset-prod/memex-building-itself/specs/spec-371/acs";
const AC_1 = `${NS}/ac-1`; // checkout writes the local thread→spec marker
const AC_2 = `${NS}/ac-2`; // no marker → zero network calls
const AC_4 = `${NS}/ac-4`; // unclaim clears; TTL releases; new claim supersedes
const AC_5 = `${NS}/ac-5`; // no checkout → silent (no nudge)
const AC_9 = `${NS}/ac-9`; // marker armed by any successful spec mutation; not on a fail
const AC_16 = `${NS}/ac-16`; // there is no first-edit nudge anywhere

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

  it("an edit with NO checkout is SILENT — no nudge, nothing leaves (ac-2, ac-5, ac-16)", () => {
    tagAc(AC_2);
    tagAc(AC_5);
    tagAc(AC_16);
    // Every unclaimed edit is silent — there is no longer any 'nudge' action.
    expect(decideEditAction("u", o()).action).toBe("silent");
    expect(decideEditAction("u", o()).action).toBe("silent");
  });

  it("an edit phones home ONLY with a fresh checkout; an expired one is silent, never a nudge (ac-2, ac-16)", () => {
    tagAc(AC_2);
    tagAc(AC_16);
    writeMarker("c", { memex: "ns/m", spec: "spec-371" }, o({ now: 1000 }));
    const d = decideEditAction("c", o({ now: 1001 }));
    expect(d.action).toBe("phone-home");
    expect(d.claim).toMatchObject({ memex: "ns/m", spec: "spec-371", ref: "ns/m/specs/spec-371" });

    // an EXPIRED checkout → silent (not a nudge), treated as un-checked-out.
    writeMarker("c2", { memex: "ns/m", spec: "spec-371" }, o({ now: 0 }));
    expect(decideEditAction("c2", o({ now: DEFAULT_TTL_MS + 1 })).action).toBe("silent");
  });
});

describe("decideMarkerAction: arm on any successful spec mutation, not on a fail (spec-371 ac-9)", () => {
  const ev = (toolName, ref, response) => ({
    session_id: "s",
    tool_name: toolName,
    tool_input: ref === undefined ? {} : { ref },
    ...(response === undefined ? {} : { tool_response: response }),
  });

  it("explicit claim_spec AND any gated mutator on a spec → write the marker (ac-9)", () => {
    tagAc(AC_9);
    for (const [tool, ref] of [
      ["mcp__memex__claim_spec", "ns/m/specs/spec-1"],
      ["mcp__memex__update_section", "ns/m/specs/spec-1/sections/s-2"], // sub-entity → parent spec
      ["mcp__memex__resolve_decision", "ns/m/specs/spec-1/decisions/dec-3"],
      ["mcp__memex__update_doc", "ns/m/specs/spec-1"], // any update_doc, not just buildward
    ]) {
      expect(decideMarkerAction(ev(tool, ref))).toEqual({
        action: "write",
        memex: "ns/m",
        spec: "spec-1",
      });
    }
  });

  it("unclaim_spec → clear; reads and non-spec refs → skip (ac-9)", () => {
    tagAc(AC_9);
    expect(decideMarkerAction(ev("mcp__memex__unclaim_spec", "ns/m/specs/spec-1"))).toEqual({
      action: "clear",
    });
    expect(decideMarkerAction(ev("mcp__memex__get_doc", "ns/m/specs/spec-1")).action).toBe("skip");
    expect(decideMarkerAction(ev("mcp__memex__list_docs")).action).toBe("skip");
  });

  it("a gated mutator that FAILED (the collision takeover) does NOT arm the thread (ac-9)", () => {
    tagAc(AC_9);
    // MCP error result shape:
    expect(
      decideMarkerAction(ev("mcp__memex__update_section", "ns/m/specs/spec-1", { isError: true })).action,
    ).toBe("skip");
    // the gate's takeover-error sentinel in the response text:
    const collision = 'Pete checked this spec out 8 minutes ago. ... call claim_spec({ ref: "ns/m/specs/spec-1" }) ...';
    expect(decideMarkerAction(ev("mcp__memex__create_decision", "ns/m/specs/spec-1", collision)).action).toBe(
      "skip",
    );
  });

  it("arms/clears identically when the MCP is plugin-namespaced (mcp__plugin_<plugin>_memex__...) (ac-9)", () => {
    tagAc(AC_9);
    // The SAME Memex server, bundled as a Claude Code plugin, exposes its tools as
    // `mcp__plugin_memex-checkout_memex__<tool>`. The bare-name strip must still
    // resolve the tool, or no marker is ever written on a real plugin install.
    expect(
      decideMarkerAction(ev("mcp__plugin_memex-checkout_memex__claim_spec", "ns/m/specs/spec-1")),
    ).toEqual({ action: "write", memex: "ns/m", spec: "spec-1" });
    expect(
      decideMarkerAction(
        ev("mcp__plugin_memex-checkout_memex__update_section", "ns/m/specs/spec-1/sections/s-2"),
      ),
    ).toEqual({ action: "write", memex: "ns/m", spec: "spec-1" });
    expect(
      decideMarkerAction(ev("mcp__plugin_memex-checkout_memex__unclaim_spec", "ns/m/specs/spec-1")),
    ).toEqual({ action: "clear" });
    expect(
      decideMarkerAction(ev("mcp__plugin_memex-checkout_memex__get_doc", "ns/m/specs/spec-1")).action,
    ).toBe("skip");
  });
});

// The task-sync STEER: a short, CONDITIONAL nag emitted after a file edit in a
// CHECKED-OUT session, nudging the agent to keep task STATE honest in Memex.
// NOTE: this is new behavior that reverses the rework's "no nudge" stance for the
// checked-out case. It needs a dedicated decision + AC on spec-371; tagging is
// deferred until that AC exists (so this suite doesn't emit a phantom AC to prod).
describe("task-sync steer: conditional nag on a checked-out edit (spec-371, AC pending)", () => {
  it("no checkout → no steer (the privacy gate gates the nag too)", () => {
    expect(decideEditSteer("none", o()).nag).toBe(false);
  });

  it("a checked-out edit → a conditional nag naming the spec + all three task-state moves, plus the no-op license", () => {
    writeMarker("s", { memex: "ns/m", spec: "spec-371" }, o({ now: 1000 }));
    const r = decideEditSteer("s", o({ now: 1001 }));
    expect(r.nag).toBe(true);
    expect(r.text).toContain("spec-371");
    expect(r.text).toContain("update_task"); // completed a task → done
    expect(r.text).toContain("in progress"); // started a picked-up task → in progress
    expect(r.text).toContain("create_task"); // untracked work → create the task
    expect(r.text).toMatch(/no update is needed/i); // mid-task edit → explicitly no premature update
  });

  it("ships as the simple stick (every edit) but is throttle-ready: NAG_MIN_INTERVAL_MS + lastNagAt", () => {
    expect(NAG_MIN_INTERVAL_MS).toBe(0); // v1 default: nag after every edit
    writeMarker("t", { memex: "ns/m", spec: "spec-9" }, o({ now: 0 }));
    // simulate a throttle window via opts.nagIntervalMs (the constant in prod)
    expect(decideEditSteer("t", o({ now: 100, nagIntervalMs: 1000 })).nag).toBe(true); // first → nag + stamp
    expect(decideEditSteer("t", o({ now: 200, nagIntervalMs: 1000 })).nag).toBe(false); // within window → throttled
    expect(decideEditSteer("t", o({ now: 1200, nagIntervalMs: 1000 })).nag).toBe(true); // past window → nag again
  });

  it("edit activity preserves the nag clock — the throttle survives intervening edits", () => {
    writeMarker("p", { memex: "ns/m", spec: "spec-9" }, o({ now: 0 }));
    decideEditSteer("p", o({ now: 100, nagIntervalMs: 10000 })); // stamps lastNagAt=100
    decideEditAction("p", o({ now: 500 })); // a later edit refreshes TTL (touch) but must NOT reset the nag clock
    expect(readMarker("p", o()).lastNagAt).toBe(100); // preserved across touch
    expect(decideEditSteer("p", o({ now: 600, nagIntervalMs: 10000 })).nag).toBe(false); // still throttled
  });
});
