// spec-303 dec-9 / dec-10 — entitlement for the in-app journey preview.
//
// This is AUTHORISATION bound to DEPLOY CONFIG, not a billing entitlement (dec-10).
// The code checks a capability and never names a vendor domain: JOURNEY_PREVIEW_DOMAINS
// is a CSV of email domains set per deployment (the SaaS prod env sets it to the
// operator domain; a self-hoster sets their own; unset = nobody can preview), so no
// company-specific string ships in the open source (std-22). The check is
// server-enforced — in open source a client-side gate would be a visible bypass.

export function previewDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.JOURNEY_PREVIEW_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/** True iff the caller's email domain is in the deployment's preview allow-list.
 * Empty/unset config → nobody. A malformed/absent email → false. */
export function canPreviewJourneys(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  if (!domain) return false;
  return previewDomains(env).includes(domain);
}
