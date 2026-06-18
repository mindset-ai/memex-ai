// spec-303 — Home Canvas journey-state API. Caller-scoped (no memex needed): the
// Home Canvas is a user-level surface (dec-2). Mounted under /api/me.
import { Hono } from "hono";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import { getUserJourneyState, isValidStepId } from "../services/journey-state.js";
import { canPreviewJourneys } from "../services/journey-preview.js";
import { recordUsageEvent } from "../services/usage-events.js";

export const journeyRouter = new Hono<SessionEnv>();

journeyRouter.use("*", sessionMiddleware);

// GET /api/me/journey-state — the user's DERIVED onboarding position (dec-3). The
// response carries the real milestones + the current step id; `canPreview` tells
// the UI whether to offer the operator preview control (dec-9).
//
// dec-8: an authorised operator may PIN the canvas to any step on their OWN account
// via ?preview=<stepId> — render-only, real state untouched. A caller without the
// capability (or an unknown step id) is simply ignored and gets the truth; we never
// 403 (std-7) and never let a non-operator force a state.
journeyRouter.get("/journey-state", async (c) => {
  const user = c.get("user");
  const state = await getUserJourneyState(user.id);
  const canPreview = canPreviewJourneys(user.email);

  const previewStep = c.req.query("preview");
  if (previewStep && canPreview && isValidStepId(previewStep)) {
    return c.json({
      milestones: state.milestones,
      currentStepId: previewStep,
      // `steps` always reflects REAL attainment — preview pins the card, not progress.
      steps: state.steps,
      preview: true,
      canPreview,
    });
  }

  return c.json({
    milestones: state.milestones,
    currentStepId: state.currentStepId,
    steps: state.steps,
    preview: false,
    canPreview,
  });
});

// POST /api/me/journey-event — Home Canvas measurement (ac-7): which step a user was
// shown, and which CTA they took. Advisory only: a bad body is a 400, a telemetry
// failure is swallowed by recordUsageEvent, and neither ever blocks the canvas.
journeyRouter.post("/journey-event", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    action?: unknown;
    step?: unknown;
    cta?: unknown;
  };
  const action = body.action;
  const step = typeof body.step === "string" ? body.step : null;

  if ((action !== "shown" && action !== "cta") || !step || !isValidStepId(step)) {
    return c.json({ error: "Invalid journey event" }, 400);
  }

  await recordUsageEvent({
    memexId: null,
    actorUserId: user.id,
    name: action === "shown" ? "home_canvas.step_shown" : "home_canvas.cta_clicked",
    source: "frontend",
    props: {
      step,
      ...(typeof body.cta === "string" ? { cta: body.cta } : {}),
    },
  });

  return c.json({ ok: true });
});
