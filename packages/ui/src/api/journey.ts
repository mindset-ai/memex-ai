// spec-303 — Home Canvas journey-state client. Caller-scoped (/api/me), so it goes
// through the flat BASE_URL, not a tenant prefix (the Home Canvas is user-level).
import { BASE_URL, fetchWithRetry } from './http';

// spec-305 — the user-scoped milestones the journey derives position from. identity
// is the one CAPTURED milestone (dec-4); the rest are derived from real activity.
export interface JourneyMilestones {
  identityConfirmed: boolean;
  mcpConnected: boolean;
  // Non-gating: the user's first MCP tool call, drives the connect-agent reward dismiss.
  mcpToolCalled: boolean;
  hasSpec: boolean;
  hasResolvedDecision: boolean;
  hasAc: boolean;
  acVerified: boolean;
}

export interface JourneyStepStatus {
  id: string;
  attained: boolean;
}

export interface JourneyStateResponse {
  milestones: JourneyMilestones;
  currentStepId: string;
  // Per-step real attainment (drives the progress map). Reflects true state even
  // under preview.
  steps: JourneyStepStatus[];
  preview: boolean;
  canPreview: boolean;
}

/** Fetch the user's derived journey position. `previewStep` (operator-only,
 * enforced server-side) pins the returned step without touching real state. */
export async function fetchJourneyStateApi(
  previewStep?: string | null,
): Promise<JourneyStateResponse> {
  const q = previewStep ? `?preview=${encodeURIComponent(previewStep)}` : '';
  const res = await fetchWithRetry(`${BASE_URL}/me/journey-state${q}`);
  if (!res.ok) throw new Error(`journey-state ${res.status}`);
  return (await res.json()) as JourneyStateResponse;
}

/** Record that a step was shown / a CTA was taken (ac-7). Advisory: measurement
 * must never throw into the canvas. */
export async function postJourneyEventApi(
  step: string,
  action: 'shown' | 'cta',
  cta?: string,
): Promise<void> {
  try {
    await fetchWithRetry(`${BASE_URL}/me/journey-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, action, ...(cta ? { cta } : {}) }),
    });
  } catch {
    // swallow — telemetry is advisory
  }
}
