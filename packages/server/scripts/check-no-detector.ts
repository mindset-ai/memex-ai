#!/usr/bin/env tsx
// spec-566 t-10 (dec-8, ac-25) — the offline half of the twin guard [per std-2's pattern].
//
// ac-25 asks for this in `make check` specifically, and that is not a detail:
// NO server vitest test is offline — the suite's globalSetup provisions a
// database — and `.husky/pre-push` skips `make check` entirely. So a scan that
// lived only in the vitest tier would be met after CI, by which time the
// detector is written and the author is defending it.
//
// THE TWIN. `no-detector.regression.test.ts` asserts the same rule inside the
// suite. Two lanes for one rule is deliberate, exactly as spec-551 t-7 argued
// for the portable surface: the offline copy is what a developer feels before a
// push, and the suite copy is what survives someone bypassing the hook.
//
// Pure file reads — no database, no network, no tool registry.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  GATE_MODULE,
  formatDetectorFailure,
  scanGateForDetectors,
  scanGateForUndeclaredImports,
} from "../src/services/no-detector-scan.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const violations = scanGateForDetectors(SRC);
const undeclared = scanGateForUndeclaredImports(SRC);

if (violations.length === 0 && undeclared.length === 0) {
  console.log(`✓ done-gate carries no change detector — ${GATE_MODULE} clean [spec-566 dec-8]`);
  process.exit(0);
}

if (violations.length > 0) console.error(formatDetectorFailure(violations));

if (undeclared.length > 0) {
  console.error(
    `\n✗ ${GATE_MODULE} imports ${undeclared.length} module${undeclared.length === 1 ? "" : "s"} its declared list does not cover:\n`,
  );
  for (const spec of undeclared) console.error(`    ${spec}`);
  console.error(
    "\n  This is a tripwire, not a prohibition. Scanning the gate module alone would\n" +
      "  be defeated by putting the comparison in a helper the gate imports, so a new\n" +
      "  dependency has to be acknowledged. If it carries no prior statement, hash or\n" +
      "  verification-relative timestamp, add it to DECLARED_IMPORTS in\n" +
      "  src/services/no-detector-scan.ts and say in the commit why the gate needed it.\n",
  );
}

process.exit(1);
