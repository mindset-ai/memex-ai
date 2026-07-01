// spec-427 t-6 (dec-9) — the activation-drip master switch + kill switch.
//
// ACTIVATION_EMAILS_ENABLED is an EXPLICIT flag, default OFF, enabled only in prod and
// only by hand. Chosen over an implicit `env === 'prod'` check so the ~97-user backlog
// fires only when a human deliberately flips it (the launch moment), and so flipping it
// back off stops everything with no redeploy (the kill switch). Both the daily drip
// (t-7) and the one-time backlog (t-8) consult it, AND the sendLifecycleEmail chokepoint
// hard-enforces it, so no activation/lifecycle email can send while it is off.
//
// This gates LIFECYCLE mail only. The spec-428 transactional welcome uses a different
// path (sendWelcomeEmail) and is NOT gated by this flag (ac-16).

const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * True only when ACTIVATION_EMAILS_ENABLED is explicitly set to a truthy value
 * (case-insensitive: 1/true/yes/on). Unset, empty, or anything else → OFF. Read live
 * (not cached) so flipping the env var is an immediate kill switch on the next send.
 */
export function activationEmailsEnabled(): boolean {
  return ON_VALUES.has((process.env.ACTIVATION_EMAILS_ENABLED ?? "").trim().toLowerCase());
}
