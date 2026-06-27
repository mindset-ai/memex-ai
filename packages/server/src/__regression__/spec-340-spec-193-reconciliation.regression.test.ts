// spec-340 t-7 — reconcile the spec-193 guard with spec-340's auto-assigned tags.
//
// spec-193 dec-1 set a "no stored tags" default: the agent classifies its work and
// reaches standards by semantic search, with NO hand-maintained standard↔tripwire
// MAP in the product prompting layer. spec-340 introduces AUTO-ASSIGNED clause→facet
// tags in the DB (standard_clause_facets), written by the agent-driven classifier.
// These are NOT the thing spec-193 forbade — they are derived data, not a
// hand-maintained product map — so the two coexist.
//
// This guard pins the narrowing executably (ac-34): the spec-193 bridge-table
// prohibition stays SCOPED TO THE SCAFFOLD LAYER, and the auto-assigned clause→facet
// DB tags are permitted.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-340/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const SHARED_SRC = join(SERVER_ROOT, "..", "shared", "src");
const read = (p: string) => readFileSync(p, "utf-8");

const guard = read(join(SERVER_ROOT, "src", "__regression__", "spec-193-tripwire.regression.test.ts"));
const scaffoldData = read(join(SHARED_SRC, "scaffold-data.ts"));
const schema = read(join(SERVER_ROOT, "src", "db", "schema.ts"));

describe("spec-340 ↔ spec-193 reconciliation (spec-340 t-7)", () => {
  it("the spec-193 guard still FORBIDS a hand-maintained map, scoped to the scaffold layer (ac-34)", () => {
    tagAc(AC(34));
    // The prohibition exists and targets scaffoldData (the product prompting layer),
    // not the DB schema — so it bans a hand-maintained product-side map, nothing more.
    expect(guard).toMatch(/scaffoldData\)\.not\.toMatch\(\/tripwireTag\|standardTripwireMap\|TRIPWIRE_TO_STANDARD\|bridge\[- \]\?table\/i\)/);
    // And the scaffold layer genuinely carries no such hand-maintained map today.
    expect(scaffoldData).not.toMatch(/tripwireTag|standardTripwireMap|TRIPWIRE_TO_STANDARD|bridge[- ]?table/i);
    // The narrowing is documented in the guard for a future reader (ac-34: legible intent).
    expect(guard).toMatch(/spec-340 RECONCILIATION/);
  });

  it("PERMITS spec-340's auto-assigned clause→facet DB tags (ac-34)", () => {
    tagAc(AC(34));
    // The auto-assigned tags live in the DB schema (derived data), NOT the scaffold
    // layer — this is what the narrowed guard explicitly allows.
    expect(schema).toMatch(/export const standardClauseFacets = pgTable\(/);
    // They are clause→facet membership rows (a tag store), exactly the kind of stored
    // tag spec-193's default ruled out for the PRODUCT layer but spec-340 reverses for
    // the DB. Confirm the prohibition does not reach the schema file.
    expect(schema).toMatch(/facetId: uuid\("facet_id"\)/);
  });
});
