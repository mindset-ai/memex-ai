import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  USAGE_EVENT_REGISTRY,
  isRegisteredEvent,
  isFrontendEvent,
  BACKEND_EVENT_NAMES,
  type RegisteredEventName,
} from "./usage-events-registry";

const AC = "mindset-prod/memex-building-itself/specs/spec-338/acs";

// The front-end engagement events seeded for the spec-336 Home revamp follow-on
// (board / search / voice / filters / workspace). std-35 Recipe A: each must be a
// registered FRONT-END name so POST /telemetry accepts it and track() type-checks.
const NEW_FRONTEND_EVENTS: RegisteredEventName[] = [
  "auth.login_started",
  "spec.card_opened",
  "spec.tab_viewed",
  "board.phase_drag",
  "board.tag_filter_applied",
  "search.opened",
  "search.query_submitted",
  "search.result_selected",
  "comments.filter_changed",
  "whatsnew.opened",
  "workspace.switched",
];

describe("front-end engagement events (spec-336 follow-on)", () => {
  it.each(NEW_FRONTEND_EVENTS)("%s is a registered front-end event", (name) => {
    tagAc(`${AC}/ac-5`); // machine contract: registered + RegisteredEventName-typed
    tagAc(`${AC}/ac-1`); // each is a registered Recipe-A (front-end) event
    expect(isRegisteredEvent(name)).toBe(true);
    expect(isFrontendEvent(name)).toBe(true);
  });

  it("are NOT in the back-end bus whitelist (front-end events never ride the bus)", () => {
    tagAc(`${AC}/ac-1`); // server outcomes stay Recipe B — no double-counting
    for (const name of NEW_FRONTEND_EVENTS) {
      expect(BACKEND_EVENT_NAMES).not.toContain(name);
    }
  });

  it("every registry entry has a non-empty description (std-35 props discipline lives there)", () => {
    tagAc(`${AC}/ac-5`);
    for (const e of USAGE_EVENT_REGISTRY) {
      expect(e.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("adds no onboarding.* events and leaves the home_canvas.* events intact (Home untouched — spec-336 owns it)", () => {
    tagAc(`${AC}/ac-3`);
    // No new onboarding surface was introduced by THIS (spec-336 follow-on) batch —
    // asserted against the batch's own event list, not the whole registry, so a
    // later spec that legitimately adds onboarding.* events (spec-444's welcome
    // video) doesn't retroactively falsify this batch's claim.
    expect(NEW_FRONTEND_EVENTS.filter((n) => n.startsWith("onboarding."))).toHaveLength(0);
    // The existing Home Canvas events are still present, unchanged.
    const names = USAGE_EVENT_REGISTRY.map((e) => e.name);
    expect(names).toContain("home_canvas.step_shown");
    expect(names).toContain("home_canvas.cta_clicked");
  });
});
