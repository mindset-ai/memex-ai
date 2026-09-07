#!/usr/bin/env tsx
// spec-551 t-7 (dec-5) — the offline half of the twin guard [per std-2's pattern].
//
// std-22 cl-60 records enforcement of the portable surface as "review-based — there is
// no automated guard yet", and cl-66 sketches the missing one. Review then let bare
// handle citations ship across four surfaces. This is that guard, in the lane where a
// developer meets it before a push rather than after CI.
//
// WHY OFFLINE MATTERS, and it was established by running it rather than predicted:
// the collector reaches the live tool registry, which imports the database module —
// so it looked like it might need Postgres. It does not. `postgres()` builds a client
// lazily and nothing queries during collection, so with DATABASE_URL unset this walks
// 1,397 strings and exits clean. That is what lets the check sit in `make check`, the
// sub-second no-database lane, instead of only in the vitest tier.
//
// THE TWIN. `portable-surface.portability.test.ts` asserts the same rule inside the
// vitest suite (which pre-push already runs via `test:unit`). Two lanes for one rule
// is deliberate: the offline copy is what a developer actually feels, and the suite
// copy is what survives someone bypassing the hook.

import { collectPortableSurface } from "../src/db/portable-surface.js";
import { scanForEntityHandles } from "../src/db/portability-scan.js";

const corpus = await collectPortableSurface();
const violations = scanForEntityHandles(corpus);

if (violations.length === 0) {
  console.log(
    `✓ portable surface clean — ${corpus.length} rendered strings, no bare entity handle`,
  );
  process.exit(0);
}

// Every occurrence and its site. A gate that names one of five leaves four in the
// tree: you fix what it named, it goes green, and the rest ship.
console.error(
  `✗ ${violations.length} bare entity handle${violations.length === 1 ? "" : "s"} on the portable surface.\n`,
);
console.error(
  "  A handle like `std-18` or `dec-11` means nothing in a customer's Memex — it resolves\n" +
    "  nowhere, or worse, to a different rule with the same number [per std-22 cl-19].\n",
);
for (const violation of violations) console.error(`  ${violation}`);
console.error(
  "\n  Fix by kind:\n" +
    "    • the sentence already states the rule  → delete the handle\n" +
    "    • the reader may hold an equivalent rule → instruct a runtime standards search [cl-22]\n" +
    "    • the rule is about Memex itself         → write the full canonical ref [std-10 §6]\n" +
    "    • the handle only demonstrates a SHAPE   → de-number it (`spec-N`, not `spec-3`)\n",
);
process.exit(1);
