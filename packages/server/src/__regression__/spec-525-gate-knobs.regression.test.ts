// spec-525 t-6 — the admission gate's knobs reach Cloud Run.
//
// Same shape as spec-518-scaling-budget.regression.test.ts, and for the same reason
// that Spec exists at all: `14568776` happened because CI never read the canonical
// deploy-env secret, so prod ran at the wrong MAX_INSTANCES and DB_POOL_MAX for WEEKS
// while the correct values sat unread — and the 2026-08-03 shedding incident followed.
//
// The failure mode here is worse than a wrong number: a dropped MEMEX_EMISSION_GATE_MODE
// means shipping shadow mode while believing enforcement is on, or the reverse. Nothing
// in the running system would say so. A static assertion turns that into a red CI run.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  DEFAULT_GATE_MODE,
  DEFAULT_WAIT_MS,
  DEFAULT_SERVICE_MS,
  resolveGateMode,
  resolveWaitConfig,
} from "../services/admission/emission-gate.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_SHADOW = `${SPEC}/ac-17`; // shadow/enforcing is configuration, not a code change
const AC_BOUNDS = `${SPEC}/ac-18`; // interval and ceiling configurable without a code change

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_SH = readFileSync(
  join(REPO_ROOT, "packages", "server", "deploy.sh"),
  "utf-8",
);
const DEPLOY_CONFIG = readFileSync(
  join(REPO_ROOT, "scripts", "deploy-config.sh"),
  "utf-8",
);

/** The three knobs t-6 wires. The ceiling is deliberately NOT among them — see below. */
const KNOBS = [
  "MEMEX_EMISSION_GATE_MODE",
  "MEMEX_EMISSION_WAIT_MS",
  "MEMEX_EMISSION_MAX_WAITERS",
] as const;

describe("spec-525 t-6: the knobs are wired end to end, both edits", () => {
  it.each(KNOBS)(
    "%s reaches Cloud Run via deploy.sh's --update-env-vars, in the optional form",
    (knob) => {
      tagAc(AC_SHADOW);
      // The ${VAR+|VAR=${VAR}} form omits the entry when the variable is unset, so the
      // --update-env-vars MERGE leaves a live setting intact rather than blanking it.
      // A deploy from a checkout that never set the value cannot silently flip the mode.
      expect(DEPLOY_SH).toContain(`\${${knob}+|${knob}=\${${knob}}}`);
    },
  );

  it.each(KNOBS)("%s is exported by deploy-config.sh only when set", (knob) => {
    tagAc(AC_SHADOW);
    // Miss THIS edit and prod silently takes the code default while the correct value
    // sits unread in the canonical secret. That is not hypothetical — it is spec-518.
    expect(DEPLOY_CONFIG).toMatch(
      new RegExp(`if \\[ -n "\\$\\{${knob}\\+set\\}" \\]; then\\s*\\n\\s*export ${knob}`),
    );
  });

  it("the CEILING is not a knob — ac-12 requires it derived from the resolved pool", () => {
    tagAc(AC_BOUNDS);
    // A hand-set ceiling is a number someone raises during a busy week, and the
    // guarantee that user traffic always retains connections disappears without a
    // trace. It follows DB_POOL_MAX instead, which IS wired.
    expect(DEPLOY_SH).not.toContain("MEMEX_EMISSION_CEILING");
    expect(DEPLOY_CONFIG).not.toContain("MEMEX_EMISSION_CEILING");
    expect(DEPLOY_SH).toContain("${DB_POOL_MAX+|DB_POOL_MAX=${DB_POOL_MAX}}");
  });
});

describe("spec-525 t-6: an unconfigured environment runs correctly, and safely", () => {
  it("every knob has a code default, so dev, tests and self-hosted need no configuration", () => {
    tagAc(AC_BOUNDS);
    const wait = resolveWaitConfig({});
    expect(resolveGateMode({})).toBe(DEFAULT_GATE_MODE);
    expect(wait.waitMs).toBe(DEFAULT_WAIT_MS);
    expect(wait.serviceMs).toBe(DEFAULT_SERVICE_MS);
  });

  it("the DEFAULT mode is the SAFE one — a wiring mistake under-protects, never over-enforces", () => {
    tagAc(AC_SHADOW);
    // This is the criterion that decides which way a mistake fails. Defaulting to
    // enforcing would mean a dropped variable silently applies untuned limits to real
    // traffic; defaulting to shadow means it silently protects nothing, which is the
    // state we are already in today.
    expect(DEFAULT_GATE_MODE).toBe("shadow");
    expect(resolveGateMode({})).toBe("shadow");
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "" })).toBe("shadow");
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "ENFORCING" })).toBe("shadow");
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "true" })).toBe("shadow");
    // Exactly one spelling turns it on, and it is the explicit one.
    expect(resolveGateMode({ MEMEX_EMISSION_GATE_MODE: "enforcing" })).toBe("enforcing");
  });

  it("junk in a knob falls back to the default rather than propagating", () => {
    tagAc(AC_BOUNDS);
    // A NaN wait interval would make every comparison false; a zero waiter bound would
    // turn the gate back into the loss system dec-4 rejected.
    expect(resolveWaitConfig({ MEMEX_EMISSION_WAIT_MS: "abc" }).waitMs).toBe(DEFAULT_WAIT_MS);
    expect(resolveWaitConfig({ MEMEX_EMISSION_WAIT_MS: "0" }).waitMs).toBe(DEFAULT_WAIT_MS);
    expect(resolveWaitConfig({ MEMEX_EMISSION_WAIT_MS: "-5" }).waitMs).toBe(DEFAULT_WAIT_MS);
    expect(resolveWaitConfig({ MEMEX_EMISSION_MAX_WAITERS: "abc" }).maxWaiters).toBeUndefined();
  });
});
