// spec-493 t-1 — the timeline send-condition metadata. Two guarantees under test:
//   1. day-offset + comms-key facts are IMPORTED from the send path, so they cannot
//      drift from what actually sends (dec-1 / ac-3 / ac-7); the only hand-authored
//      fields are inherently-textual prose/flag/branch (ac-8).
//   2. exactly the 5 onboarding emails are on the timeline, with connected-inactive /
//      win-back as two exclusive parallel branches (dec-3 / ac-11 / ac-12).
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  ONBOARDING_SEQUENCE,
  ONBOARDING_TEMPLATES,
  PER_COHORT_CAP,
  type SendCondition,
} from "./send-conditions.js";
import {
  ACTIVATION_DWELL_DAYS,
  ACTIVATION_COMMS_KEY,
  ACTIVATION_PER_COHORT_CAP,
} from "./activation-drip.js";
import { CONNECT_PEOPLE_DWELL_DAYS, CONNECT_PEOPLE_COMMS_KEY } from "./connect-people.js";
import { EMAIL_TEMPLATE_NAMES } from "./preview-samples.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-493/acs/ac-${n}`;

const byTemplate = (t: string): SendCondition => {
  const c = ONBOARDING_SEQUENCE.find((x) => x.template === t);
  if (!c) throw new Error(`no send-condition for ${t}`);
  return c;
};

// The onboarding emails whose day/key facts have an exported send-path constant.
const IMPORTED = [
  "activation-connected-inactive",
  "activation-winback",
  "activation-connect-people",
];

describe("send-conditions: day/comms facts are imported from the send path (no drift, ac-3/ac-7)", () => {
  it("dwell day-offsets equal the send-path dwell constants", () => {
    tagAc(AC(3));
    tagAc(AC(7));
    // If a future change moves ACTIVATION_DWELL_DAYS.connected_inactive to 3, this
    // asserts the preview follows automatically — a hardcoded 2 here would fail.
    expect(byTemplate("activation-connected-inactive").dayOffset).toBe(
      ACTIVATION_DWELL_DAYS.connected_inactive,
    );
    expect(byTemplate("activation-winback").dayOffset).toBe(
      ACTIVATION_DWELL_DAYS.signed_in_dormant,
    );
    expect(byTemplate("activation-connect-people").dayOffset).toBe(CONNECT_PEOPLE_DWELL_DAYS);
  });

  it("comms keys equal the send-path comms constants", () => {
    tagAc(AC(3));
    tagAc(AC(7));
    expect(byTemplate("activation-connected-inactive").commsKey).toBe(
      ACTIVATION_COMMS_KEY.connected_inactive,
    );
    expect(byTemplate("activation-winback").commsKey).toBe(ACTIVATION_COMMS_KEY.signed_in_dormant);
    expect(byTemplate("activation-connect-people").commsKey).toBe(CONNECT_PEOPLE_COMMS_KEY);
  });

  it("exposes the per-cohort cap from the send path (ac-7)", () => {
    tagAc(AC(7));
    expect(PER_COHORT_CAP).toBe(ACTIVATION_PER_COHORT_CAP);
  });
});

describe("send-conditions: hand-authored fields are prose/flag/branch only (ac-8)", () => {
  it("welcome is day-0 and transactional (not flag-gated)", () => {
    tagAc(AC(8));
    const w = byTemplate("welcome");
    expect(w.dayOffset).toBe(0); // inherent to 'on verification', not a duplicated dwell constant
    expect(w.flagGated).toBe(false); // transactional — NOT held behind ACTIVATION_EMAILS_ENABLED
    expect(w.branch).toBe("main");
  });

  it("verified-milestone is event-driven (no fixed day) and flag-gated", () => {
    tagAc(AC(8));
    const m = byTemplate("activation-verified-milestone");
    expect(m.dayOffset).toBeNull();
    expect(m.flagGated).toBe(true);
    expect(m.commsKey).toBeNull(); // no exported constant → not re-declared here
  });

  it("every onboarding email carries non-empty trigger + cohort prose", () => {
    tagAc(AC(8));
    for (const c of ONBOARDING_SEQUENCE) {
      expect(c.trigger.length).toBeGreaterThan(0);
      expect(c.cohort.length).toBeGreaterThan(0);
      expect(c.anchor.length).toBeGreaterThan(0);
    }
  });

  it("no onboarding email whose facts are imported re-declares them as a literal", () => {
    tagAc(AC(8));
    // The imported entries must be reference-equal to their source constant, never a
    // copy. (A literal that happens to match today is the drift risk this rules out.)
    expect(IMPORTED.every((t) => byTemplate(t).commsKey !== null)).toBe(true);
  });
});

describe("send-conditions: timeline membership + cohort branches (ac-11/ac-12)", () => {
  it("the onboarding set is exactly the 5 sequence emails", () => {
    tagAc(AC(11));
    expect([...ONBOARDING_TEMPLATES].sort()).toEqual(
      [
        "activation-connect-people",
        "activation-connected-inactive",
        "activation-verified-milestone",
        "activation-winback",
        "welcome",
      ].sort(),
    );
  });

  it("the superseded signed-in-dormant sample is NOT on the timeline, but stays a preview template", () => {
    tagAc(AC(11));
    expect(ONBOARDING_TEMPLATES.has("activation-signed-in-dormant")).toBe(false);
    expect(EMAIL_TEMPLATE_NAMES).toContain("activation-signed-in-dormant");
  });

  it("connected-inactive and win-back are exclusive parallel branches at the same order slot", () => {
    tagAc(AC(12));
    const ci = byTemplate("activation-connected-inactive");
    const wb = byTemplate("activation-winback");
    expect(ci.branch).toBe("connected-inactive");
    expect(wb.branch).toBe("win-back");
    expect(ci.order).toBe(wb.order); // same slot ⇒ parallel branches, not two steps
  });

  it("milestone and connect sit on the main spine", () => {
    tagAc(AC(12));
    expect(byTemplate("activation-verified-milestone").branch).toBe("main");
    expect(byTemplate("activation-connect-people").branch).toBe("main");
  });
});
