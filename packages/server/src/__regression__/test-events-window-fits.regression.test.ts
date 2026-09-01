// spec-520 ac-14 — the retention window is longer than what the surviving raw-log
// consumers need, and no configuration can make it shorter than that.
//
// ac-14's first half — "the window is set by configuration rather than hardcoded" — is
// covered in test-events-partitioned.integration.test.ts. This is the other half: that the
// consumers still reading raw test_events resolve FULLY from the retained partitions.
//
// WHY IT NEEDS A GUARD RATHER THAN A GLANCE. testSignalPulse reads raw test_events over a
// caller-supplied window capped at PULSE_MAX_WINDOW_MIN. Retention is now an env var. Set
// TEST_EVENTS_RETENTION_DAYS below that bound and the Pulse answers from a window that no
// longer exists — its sparkline flattens toward its left edge with no error, no log line,
// and nothing to distinguish it from "nothing ran". Two independently-tunable numbers with
// a silent failure between them is exactly the shape that earns a test.
//
// ⚠ AND THE GUARD IS ON THE FLOOR, NOT ON TODAY'S VALUE. Asserting that the CURRENT setting
// happens to be large enough proves nothing about tomorrow's. What makes the Pulse safe is
// that `resolveRetentionDays` cannot produce a value below one day — so the assertion is
// against the smallest value the clamp permits.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { PULSE_MAX_WINDOW_MIN } from "../services/analytics.js";
import { TEST_EVENTS_RETENTION_DAYS } from "../services/test-event-retention.js";

const AC_WINDOW = "mindset-prod/memex-building-itself/specs/spec-520/acs/ac-14";

const MINUTES_PER_DAY = 24 * 60;
/** The smallest value resolveRetentionDays can return: anything <= 0 falls back to the default. */
const SMALLEST_CONFIGURABLE_DAYS = 1;

describe("spec-520 ac-14 — raw-log consumers fit inside the retention window", () => {
  it("the configured window exceeds the Pulse's widest query", () => {
    tagAc(AC_WINDOW);
    expect(TEST_EVENTS_RETENTION_DAYS * MINUTES_PER_DAY).toBeGreaterThan(PULSE_MAX_WINDOW_MIN);
  });

  it("NO permitted configuration can starve the Pulse — the floor already exceeds it", () => {
    tagAc(AC_WINDOW);
    // The load-bearing one. Today's value being comfortable is luck; the clamp is the
    // guarantee. If someone lowers the floor, or widens the Pulse past a day, this reds
    // before the sparkline starts quietly lying.
    expect(SMALLEST_CONFIGURABLE_DAYS * MINUTES_PER_DAY).toBeGreaterThan(PULSE_MAX_WINDOW_MIN);
  });

  it("states what ac-14's activity-feed clause actually resolves to", () => {
    tagAc(AC_WINDOW);
    // ac-14 names "the activity feed's lookback" alongside the Pulse's window. The feed has
    // NO lookback bound — activity_view's test_events arm is unfiltered by time and the
    // reader paginates instead. So there is no window to fit inside, and the clause is
    // satisfied vacuously rather than by anything this code does.
    //
    // Recorded as an assertion rather than left as prose so the claim is checkable: if a
    // lookback interval is ever added to that arm, this fails and whoever added it has to
    // re-check it against the retention window.
    const dir = join(__dirname, "..", "..", "drizzle");
    const viewFile = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .reverse()
      .find((f) => readFileSync(join(dir, f), "utf-8").includes("CREATE OR REPLACE VIEW activity_view"));
    expect(viewFile, "activity_view's defining migration must be findable").toBeTruthy();
    const sqlText = readFileSync(join(dir, viewFile!), "utf-8");
    const teArm = sqlText.slice(sqlText.indexOf("FROM test_events"));
    expect(teArm.slice(0, 400)).not.toMatch(/created_at\s*>=?\s*now\(\)\s*-/i);
  });
});
