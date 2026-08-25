// spec-533 t-4 — keep the wire probe's over-cap payload actually over-cap.
//
// The smoke probe (warning-header.smoke.test.ts) proves that a custom response header
// on /api/test-events survives Cloud Run and the load balancer, and it does so by
// sending metadata big enough to force the UNCONDITIONAL dropped-keys warning. That
// only works while the payload really does breach the server's caps.
//
// It cannot import the caps itself: routes/test-events.js reaches db/connection, which
// demands DATABASE_URL at module load and would kill a smoke run against a remote host
// — how the 2026-08-14 int deploy failed, and a trap spec-515 hit twice. So the size
// lives in smoke-env.ts and this NON-smoke test, which may import both, checks they
// still agree.
//
// WHY THIS GUARD EARNS ITS PLACE. If someone raises META_MAX_VALUE_CHARS above the
// probe's size, the probe stops triggering the warning — and then it fails for a reason
// that looks exactly like "the load balancer is stripping headers". Worse, if the caps
// were loosened AND the header genuinely broke, the probe would report the wrong cause.
// dec-7's whole concern is a check that stops proving what it claims to prove.

import { describe, it, expect } from "vitest";
import {
  META_MAX_TOTAL_BYTES,
  META_MAX_KEYS,
  META_MAX_VALUE_CHARS,
} from "../routes/test-events.js";
import { SMOKE_OVERCAP_VALUE_CHARS } from "../__smoke__/smoke-env.js";

// DELIBERATELY UNTAGGED. This guard protects the MECHANISM ac-20 relies on; it does not
// verify ac-20's claim, which is that the header ARRIVES on a deployed host. Tagging it
// would flip ac-20 to verified off evidence that never left this process — the false-green
// pattern this Spec exists to correct (see issue-1, where five of spec-234's criteria read
// verified off tests that checked something else). ac-20 and ac-18 stay UNTESTED until the
// smoke tier runs with SMOKE_EMIT_KEY + SMOKE_EMIT_AC_REF against int.

describe("spec-533 t-4: the smoke probe's payload is still over-cap (untagged — see above)", () => {
  it("breaches the per-value cap by a wide margin", () => {
    expect(SMOKE_OVERCAP_VALUE_CHARS).toBeGreaterThan(META_MAX_VALUE_CHARS);
    // Not merely over: over by enough that a routine loosening cannot quietly
    // disarm the probe. If this ever fails, RAISE the smoke size — do not lower
    // the assertion.
    expect(SMOKE_OVERCAP_VALUE_CHARS).toBeGreaterThan(META_MAX_VALUE_CHARS * 8);
  });

  it("breaches the total-bytes cap too, so one key is enough", () => {
    // The probe sends a single key. That has to be sufficient on its own — a probe
    // needing 32 keys to trip the limit would be fragile against the keys cap.
    expect(SMOKE_OVERCAP_VALUE_CHARS).toBeGreaterThan(META_MAX_TOTAL_BYTES);
    expect(META_MAX_KEYS).toBeGreaterThan(0); // sanity: the caps module is really loaded
  });
});
