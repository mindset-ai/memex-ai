// spec-129 ac-5 (memex-app scope) — memex-app's CI must be migrated to AUTHENTICATED
// emission (a MEMEX_EMIT_KEY present) BEFORE enforcement is enabled on any mindset-prod
// Memex. memex-app is the only Mindset repo currently emitting; the others are out of
// scope (see Overview).
//
// This is an intentional executable TODO that gates the t-7 cutover:
//
//   - Emission ON + NO key  → FAILS. This is memex-app CI's state TODAY (it emits
//     unauthenticated). The red is the signal: set the MEMEX_EMIT_KEY CI variable. The
//     same red appears on a developer machine that runs with emission on but no key.
//   - Emission ON + key set → PASSES. The state after the cutover. ac-5 goes green.
//   - Emission OFF          → SKIPPED (no emit). Developer laptops set MEMEX_EMIT=false
//     per the ac-emission guidance, so this never nags local work that isn't emitting,
//     and it never records a misleading green for an environment that emits nothing.
//
// Because it's skipped when emission is off, it does NOT falsely verify ac-5 from a
// no-op pass; it only ever reports green from an environment that actually emits with a
// configured key.

import { describe, it, expect } from "vitest";
import {
  tagAc,
  isEmissionEnabled,
  readEmissionKey,
} from "@memex-ai-ac/vitest";

const AC_5 = "mindset-prod/memex-building-itself/specs/spec-129/acs/ac-5";

describe("spec-129 ac-5: memex-app CI emits with a configured MEMEX_EMIT_KEY", () => {
  it.skipIf(!isEmissionEnabled())(
    "MEMEX_EMIT_KEY is configured wherever memex-app emits (set it in CI before enforcement)",
    () => {
      tagAc(AC_5);
      expect(
        readEmissionKey(),
        "Emission is ON but MEMEX_EMIT_KEY is unset. Set the MEMEX_EMIT_KEY CI variable " +
          "(or export it locally) before enforcement is enabled on mindset-prod, or these " +
          "emissions will be rejected 401. See spec-129 t-7.",
      ).toBeTruthy();
    },
  );
});
