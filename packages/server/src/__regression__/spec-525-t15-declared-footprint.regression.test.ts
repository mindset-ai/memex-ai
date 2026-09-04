// spec-525 t-15 — the budget guard reads a service's DECLARED per-instance footprint, and
// refuses services that declare nothing.
//
// THE DEFECT (spec-518 issue-6, which sat on a `done` Spec so nothing carried it).
// `resolvePool` takes a service's PER-POOL `DB_POOL_MAX` and treats it as its WHOLE
// per-instance footprint. That is true of memex-api, which opens one pool. It is false of
// `backstage`, which opens TWO postgres-js clients sized by that one variable. Today
// backstage sets nothing, so `foreign-default 10` applies and the count is right BY
// COINCIDENCE (1 × 10 == 2 × 5). The moment it sets a per-pool value the guard
// under-counts — and passes green.
//
//   real    = CUTOVER × maxInstances × (sum of every pool the instance opens)
//   counted = CUTOVER × maxInstances × (resolvePool result + RELAY_LISTEN_PER_INSTANCE)
//
// The `+1` belongs only to what the guard COMPUTES, never to what a service OPENS.
// backstage has no relay LISTEN — its UI polls.
//
// WHAT THIS IS NOT WORTH, stated because an earlier claim of mine got it wrong and it is
// now in the record twice (c-20 corrected by c-23). This task frees **4** connections and
// moves the achievable `DB_POOL_MAX` **not at all**: the guard already reads `maxInstances`
// from the live serving revision, so backstage counts at its real maxScale of 2 (44, not
// the 66 in `deploy.sh`'s stale comment), and 197 − 44 − 5 = 148 admits P = 8 both before
// and after. This is instrument correctness and a std-50 fix. It is not capacity.
//
// TWO PHASES, OPPOSITE ORDERING (t-15):
//   A — read + warn, lands BEFORE every service declares. A typo on the contract string is
//       otherwise indistinguishable from success: write DB_CONNECTION_PER_INSTANCE
//       (singular) and the guard finds nothing, falls back, and prints the line it prints
//       today. Phase A's warning is what makes the phase-B switch an EVIDENCED decision —
//       flip it when the warning goes quiet — rather than a remembered one.
//   B — refuse + retire the inference branches, lands AFTER. Behind a switch, off by
//       default, because the refusal aborts memex-api's OWN deploys while anything is
//       undeclared.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  serviceTerm,
  computeBudget,
  formatBudgetReport,
  parseRevisionScaling,
  decideOutcome,
  declarationWarnings,
  undeclaredServices,
  DECLARATION_VAR,
  UNBLOCK_HINT,
  RELAY_LISTEN_PER_INSTANCE,
  CUTOVER_REVISION_FACTOR,
  FOREIGN_SERVICE_DEFAULT_POOL,
  type ServiceObservation,
} from "../deploy/scaling-budget.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-525/acs";
const AC_DECLARED = `${SPEC}/ac-27`;

/** memex-api's real shape: one pool of 4 plus the bus relay's `max: 1`. */
const API: ServiceObservation = {
  service: "memex-api",
  revision: "memex-api-fixture-001",
  maxInstances: 8,
  dbPoolMax: 4,
  ownCode: true,
};

/**
 * backstage's real shape, from a LABELLED FIXTURE rather than its live annotation.
 *
 * The property must hold at ANY maxScale: hardcoding the 2 it runs today, or reading it
 * live, would break this suite on their next deploy for a reason that has nothing to do
 * with the property. `maxScale` moved once already (3 → 2, their PR #62).
 */
const backstageFixture = (maxInstances: number, over: Partial<ServiceObservation> = {}) => ({
  service: "backstage",
  revision: `backstage-fixture-maxscale-${maxInstances}`,
  maxInstances,
  ...over,
});

describe("spec-525 t-15 phase A: a declared footprint is counted from the declaration", () => {
  it("counts a declaring service from its declaration, and adds NO relay on top", () => {
    tagAc(AC_DECLARED);

    // The declaration is a COMPLETE per-instance footprint — every pool the instance opens
    // plus any long-lived connection outside one. Adding the guard's own `+1` on top of it
    // would over-count by exactly the term the declaration already includes.
    const term = serviceTerm(backstageFixture(2, { declaredPerInstance: 10 }));

    expect(term.poolSource).toBe("declared");
    expect(term.perInstance).toBe(10); // NOT 11
    expect(term.relayCounted).toBe(false);
    expect(term.steady).toBe(2 * 10);
    expect(term.peak).toBe(CUTOVER_REVISION_FACTOR * 2 * 10);
  });

  it("keeps adding the relay for a service that has NOT declared", () => {
    tagAc(AC_DECLARED);

    // The safe branch, unchanged. Over-counting an undeclared service costs headroom;
    // under-counting it is the defect this guard exists to catch.
    const term = serviceTerm(backstageFixture(2));
    expect(term.poolSource).toBe("foreign-default");
    expect(term.poolMax).toBe(FOREIGN_SERVICE_DEFAULT_POOL);
    expect(term.relayCounted).toBe(true);
    expect(term.perInstance).toBe(FOREIGN_SERVICE_DEFAULT_POOL + RELAY_LISTEN_PER_INSTANCE);
  });

  it("does not print a relay LISTEN it did not count", () => {
    tagAc(AC_DECLARED);

    // The twin defect: `formatBudgetReport` hardcoded `+ 1 relay LISTEN` on EVERY line. For
    // a service counted from a complete declaration that is a lie — the counted-vs-real
    // confusion removed from the arithmetic, left standing in what a human reads.
    const budget = computeBudget({
      services: [API, backstageFixture(2, { declaredPerInstance: 10 })],
      usable: 197,
    });
    const report = formatBudgetReport(budget).join("\n");

    const backstageLine = report.split("\n").find((l) => l.includes("backstage")) ?? "";
    expect(backstageLine).not.toContain("relay LISTEN");
    expect(backstageLine).toContain("declared");
    // And the undeclared/inferred lines still say where their number came from.
    const apiLine = report.split("\n").find((l) => l.includes("memex-api")) ?? "";
    expect(apiLine).toContain("relay LISTEN");
  });

  it("reads the declaration off the revision, beside DB_POOL_MAX", () => {
    tagAc(AC_DECLARED);

    const parsed = parseRevisionScaling({
      metadata: {
        name: "backstage-00042-abc",
        annotations: {
          "autoscaling.knative.dev/maxScale": "2",
          "run.googleapis.com/cloudsql-instances": "p:r:i",
        },
      },
      spec: {
        containers: [
          {
            env: [
              { name: "DATABASE_URL", value: "postgres://…" },
              { name: DECLARATION_VAR, value: "10" },
            ],
          },
        ],
      },
    });

    expect(parsed.declaredPerInstance).toBe(10);
    expect(parsed.dbPoolMax).toBeUndefined();
    expect(parsed.maxInstances).toBe(2);
  });

  it("warns for every service on a default branch, naming the exact variable", () => {
    tagAc(AC_DECLARED);

    // WHY THIS EXISTS: during the whole of phase A a typo is indistinguishable from
    // success. `DB_CONNECTION_PER_INSTANCE` (singular) makes the guard find nothing, fall
    // back to foreign-default 10, and print `pool 10 [foreign-default]` — byte for byte the
    // line it prints today. Not a silent failure: a SUCCESS SIGNAL, on the one string that
    // IS the contract.
    const budget = computeBudget({
      services: [API, backstageFixture(2)],
      usable: 197,
    });
    const warnings = declarationWarnings(budget);

    expect(warnings.join("\n")).toContain("backstage");
    expect(warnings.join("\n")).toContain(DECLARATION_VAR);
    // memex-api has not declared either — the contract is symmetric or it is not a contract.
    expect(warnings.join("\n")).toContain("memex-api");

    // And it goes QUIET once everything declares. That is the phase-B gate: flip the switch
    // when this list is empty, rather than when someone remembers to.
    const declared = computeBudget({
      services: [
        { ...API, declaredPerInstance: 5 },
        backstageFixture(2, { declaredPerInstance: 10 }),
      ],
      usable: 197,
    });
    expect(declarationWarnings(declared)).toEqual([]);
  });

  it("never tests a declared total against DB_POOL_MAX", () => {
    tagAc(AC_DECLARED);

    // The coherent relation DIFFERS PER SERVICE — memex-api's total is pool + relay (5 =
    // 4+1), backstage's is 2 × pool. The guard has no way to know which form applies, and
    // that missing knowledge is the entire reason declarations exist. Any coherence check
    // would be the guessing this task removes, wearing an equals sign.
    const bothPublished = backstageFixture(2, { dbPoolMax: 5, declaredPerInstance: 10 });
    const term = serviceTerm(bothPublished);
    expect(term.poolSource).toBe("declared");
    expect(term.perInstance).toBe(10); // the declaration, not 5+1 and not 2x5
    expect(
      declarationWarnings(computeBudget({ services: [bothPublished], usable: 197 })),
    ).toEqual([]);
  });
});

describe("spec-525 t-15 phase B: refusing the undeclared, behind a switch", () => {
  it("is OFF by default, so landing it cannot abort our own deploys", () => {
    tagAc(AC_DECLARED);

    // Phase B refuses undeclared services. Every service is undeclared the day it lands, so
    // an on-by-default switch would abort memex-api's own deploy — the guard working
    // correctly and stopping all work.
    const budget = computeBudget({ services: [API, backstageFixture(2)], usable: 197 });
    expect(undeclaredServices(budget, {})).toEqual([]);
    expect(undeclaredServices(budget, { requireDeclarations: false })).toEqual([]);
  });

  it("with the switch on, an undeclared service fails and the message names the string", () => {
    tagAc(AC_DECLARED);

    const budget = computeBudget({ services: [API, backstageFixture(2)], usable: 197 });
    const refusals = undeclaredServices(budget, { requireDeclarations: true });

    expect(refusals.length).toBe(2);
    const message = refusals.join("\n");
    expect(message).toContain(DECLARATION_VAR);
    expect(message).toContain("backstage");
    expect(message).toContain("memex-api");
    // The names actually FOUND, so a near-miss is diagnosable from the failure alone rather
    // than by going and reading the revision.
    expect(message).toContain("foreign-default");

    // AND ITS OWN OFF-SWITCH, in the message rather than in a standard someone has to find.
    // This refusal can be triggered by a change nobody here made — the guard enumerates
    // every service attached to the same Cloud SQL instance, so another team renaming their
    // variable stops OUR deploys, including a hotfix. The remedy is one variable; a remedy
    // that takes one word and is known to nobody costs hours at 3am.
    expect(message).toContain(UNBLOCK_HINT);
    expect(message).toContain("REQUIRE_CONNECTION_DECLARATIONS");
    expect(UNBLOCK_HINT).toMatch(/unset|TO UNBLOCK/i);
  });

  it("closes the two-pools-one-variable under-count at ANY maxScale", () => {
    tagAc(AC_DECLARED);

    // THE defect, in the shape that actually bites: backstage sets a PER-POOL value and
    // declares nothing. The guard reads it as a whole footprint and under-counts by up to
    // 2x — silently, and passing. Phase B is what closes it: with declarations required,
    // this configuration cannot get through at all.
    //
    // Asserted across maxScale values rather than at the 2 it runs today, because the
    // property must not depend on their next deploy.
    for (const maxInstances of [1, 2, 3, 5, 8]) {
      const perPoolOnly = backstageFixture(maxInstances, { dbPoolMax: 5 });
      const term = serviceTerm(perPoolOnly);

      // What the guard computes from a per-pool value…
      expect(term.poolSource).toBe("applied");
      expect(term.perInstance).toBe(5 + RELAY_LISTEN_PER_INSTANCE);
      // …against what backstage actually opens: TWO pools of 5, and no relay LISTEN.
      const realPerInstance = 2 * 5;
      expect(term.perInstance).toBeLessThan(realPerInstance + RELAY_LISTEN_PER_INSTANCE);
      expect(term.peak).toBeLessThan(CUTOVER_REVISION_FACTOR * maxInstances * realPerInstance);

      // And phase B refuses it, so the under-count is never what a deploy runs on.
      const refused = undeclaredServices(
        computeBudget({ services: [perPoolOnly], usable: 197 }),
        { requireDeclarations: true },
      );
      expect(refused.length).toBe(1);
      expect(refused[0]).toContain(DECLARATION_VAR);
    }
  });
});

describe("spec-525 t-15: no message ever prints `undefined` for a declared service", () => {
  it("survives an over-budget report where every term is declared", () => {
    tagAc(AC_DECLARED);

    // THE DEFECT THIS PINS, found in a live int deploy log rather than in review:
    //
    //   ⚠ connection budget exceeded: peak 41 > 22 usable
    //     (memex-api 2×3×(undefined+1)=36 + admin 5)
    //
    // `decideOutcome`'s detail string read `t.poolMax` and hardcoded `+1` for EVERY term.
    // Making `poolMax` optional (a declared service has no per-pool figure) fixed
    // `formatBudgetReport`, which branches on `relayCounted` — and missed this second
    // formatter, which does not. `tsc` cannot help: interpolating `number | undefined`
    // into a template literal is perfectly legal.
    //
    // Asserted as a PROPERTY over every message this module produces, not at the one site.
    // Naming the site would pin the bug I already know about; the property catches the next
    // reader of an optional field — which is how this one got in.
    const usable = 22; // int's db-f1-micro default (25) minus superuser_reserved (3)
    const services = [
      { service: "memex-api", revision: "rev-1", maxInstances: 3, declaredPerInstance: 6, ownCode: true },
      { service: "other", revision: "rev-2", maxInstances: 2, declaredPerInstance: 10 },
    ];
    const budget = computeBudget({ services, usable });
    expect(budget.withinBudget).toBe(false); // the fixture must actually blow the budget

    const outcome = decideOutcome({ env: "int", budget, comparison: undefined, revision: undefined });
    const everything = [
      ...formatBudgetReport(budget),
      ...declarationWarnings(budget),
      ...undeclaredServices(budget, { requireDeclarations: true }),
      ...outcome.failures,
      ...outcome.warnings,
    ].join("\n");

    expect(everything.length).toBeGreaterThan(0);
    expect(everything).not.toContain("undefined");
    expect(everything).not.toContain("NaN");
  });
});
