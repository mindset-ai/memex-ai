import { describe, it, expect } from "vitest";
import {
  USAGE_EVENT_REGISTRY,
  isRegisteredEvent,
  isFrontendEvent,
  BACKEND_EVENT_NAMES,
  type RegisteredEventName,
} from "./usage-events-registry";

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
  "voice.mic_permission_result",
  "voice.icon_shown",
];

describe("front-end engagement events (spec-336 follow-on)", () => {
  it.each(NEW_FRONTEND_EVENTS)("%s is a registered front-end event", (name) => {
    expect(isRegisteredEvent(name)).toBe(true);
    expect(isFrontendEvent(name)).toBe(true);
  });

  it("are NOT in the back-end bus whitelist (front-end events never ride the bus)", () => {
    for (const name of NEW_FRONTEND_EVENTS) {
      expect(BACKEND_EVENT_NAMES).not.toContain(name);
    }
  });

  it("every registry entry has a non-empty description (std-35 props discipline lives there)", () => {
    for (const e of USAGE_EVENT_REGISTRY) {
      expect(e.description.trim().length).toBeGreaterThan(0);
    }
  });
});
