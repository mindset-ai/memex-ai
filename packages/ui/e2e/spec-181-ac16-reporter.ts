// spec-181 ac-16: "The full Playwright e2e suite passes after the plan→specify
// rename — with zero skipped-to-green tests."
//
// That is a SUITE-level claim, so it is emitted from a reporter's onEnd (which
// sees the whole run verdict), not from any single journey's afterEach — a
// per-journey emission would claim suite-green when only that journey passed.
// Emits on pass AND fail per the ac-emission discipline (a failed run lands a
// failing event; the AC goes red, never silent). Deliberate `fixme` skips do
// not flip the verdict — Playwright reports those runs as 'passed'.
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
} from "@playwright/test/reporter";
import { emitAcEvents } from "./helpers/emit-ac.js";

const AC16 = ["mindset-prod/memex-building-itself/specs/spec-181/acs/ac-16"];

class Spec181Ac16Reporter implements Reporter {
  private startedAt = 0;

  onBegin(_config: FullConfig, _suite: Suite): void {
    this.startedAt = Date.now();
  }

  async onEnd(result: FullResult): Promise<void> {
    // 'interrupted'/'timedout' are failures for the suite-green claim.
    const status = result.status === "passed" ? "pass" : "fail";
    await emitAcEvents(
      AC16,
      status,
      "packages/ui/e2e (full Playwright suite)",
      Date.now() - this.startedAt,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}

export default Spec181Ac16Reporter;
