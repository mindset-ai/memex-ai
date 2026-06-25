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
      // spec-336: raw role placement so the UI can branch the journey by persona.
      roleCoords: state.roleCoords,
      currentStepId: previewStep,
      // `steps` always reflects REAL attainment — preview pins the card, not progress.
      steps: state.steps,
      preview: true,
      canPreview,
    });
  }

  return c.json({
    milestones: state.milestones,
    roleCoords: state.roleCoords,
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
    persona?: unknown;
  };
  const action = body.action;
  const step = typeof body.step === "string" ? body.step : null;

  // spec-372 dec-6 — three measurement actions, all on the same authenticated ingress:
  //   shown   → home_canvas.step_shown    (the funnel-spine, all 6 steps)
  //   cta     → home_canvas.cta_clicked   (interaction discriminators)
  //   persona → home_canvas.persona_selected (resolved persona label only, never coords)
  if (
    (action !== "shown" && action !== "cta" && action !== "persona") ||
    !step ||
    !isValidStepId(step)
  ) {
    return c.json({ error: "Invalid journey event" }, 400);
  }

  const name =
    action === "shown"
      ? "home_canvas.step_shown"
      : action === "persona"
        ? "home_canvas.persona_selected"
        : "home_canvas.cta_clicked";

  await recordUsageEvent({
    memexId: null,
    actorUserId: user.id,
    name,
    source: "frontend",
    props: {
      step,
      ...(action === "cta" && typeof body.cta === "string" ? { cta: body.cta } : {}),
      ...(action === "persona" && typeof body.persona === "string"
        ? { persona: body.persona }
        : {}),
    },
  });

  return c.json({ ok: true });
});
