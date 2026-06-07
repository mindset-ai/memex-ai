/**
 * Namespace → Memex server URL routing.
 *
 * The AC ref's namespace IS the routing instruction. The helper reads the
 * prefix of every tagged ref and routes the emission to that namespace's
 * canonical Memex server. The default routing is the safety mechanism that
 * stops production-tagged events from leaking elsewhere.
 *
 * Add a namespace here when onboarding a new hosted Memex environment.
 *
 * ⚠ PROTOCOL CONTRACT — this routing table (and the namespace→host rule) is mirrored in the
 * `ac-emission-bootstrap` get_information topic
 * (packages/server/src/guidance/ac-emission-bootstrap.json) so hand-rolled emitters in
 * other languages route correctly. Change a mapping here → update that topic too.
 */
const NAMESPACE_TO_BASE_URL: Record<string, string> = {
  "mindset-int": "https://int.memex.ai",
  "mindset-prod": "https://memex.ai",
};

// spec-90 dec-7 (B1): the multi-tenant SaaS default. memex.ai serves EVERY
// customer namespace (agent-craft, wictesting, …), not just mindset-prod — the
// namespace selects the workspace, the host is shared. So a ref whose namespace
// isn't in the explicit table above routes here rather than being skipped.
// mindset-int is the one non-SaaS host that still needs an explicit mapping;
// self-hosted / local setups set MEMEX_TEST_EVENTS_URL explicitly.
const SAAS_DEFAULT_BASE_URL = "https://memex.ai";

const conflictWarnedFor = new Set<string>();
const routedTuples = new Set<string>();

function logRoutingOnce(namespace: string, url: string): void {
  const key = `${namespace}|${url}`;
  if (routedTuples.has(key)) return;
  routedTuples.add(key);
  // eslint-disable-next-line no-console
  console.warn(`[ac-emit] routing namespace="${namespace}" → ${url}`);
}

/**
 * Resolve the destination URL for an AC ref's namespace.
 *
 * Returns null ONLY when the ref has no namespace at all (malformed) — there is
 * nothing to route. A recognised-or-unrecognised namespace always resolves to a
 * destination (spec-90 dec-7 / B1: unknown namespaces default to the SaaS host).
 *
 * Behaviour:
 * - `MEMEX_TEST_EVENTS_URL` set → use it. If it contradicts a known
 *   namespace mapping, emit a one-time conflict warning per (namespace,
 *   override-url) tuple.
 * - `NAMESPACE_TO_BASE_URL[namespace]` set → use the canonical URL.
 * - Namespace present but unmapped → default to the SaaS host (`memex.ai`),
 *   which serves every customer tenant.
 * - No namespace (malformed ref) → return null; the caller skips the POST.
 */
export function deriveEventsUrl(acUid: string): string | null {
  const slashIdx = acUid.indexOf("/");
  const namespace = slashIdx > 0 ? acUid.slice(0, slashIdx) : "";
  const canonicalBase = namespace
    ? NAMESPACE_TO_BASE_URL[namespace]
    : undefined;
  const canonicalUrl = canonicalBase
    ? `${canonicalBase}/api/test-events`
    : undefined;

  const explicit = process.env.MEMEX_TEST_EVENTS_URL;
  if (explicit) {
    if (canonicalBase && !explicit.startsWith(canonicalBase)) {
      const conflictKey = `${namespace}|${explicit}`;
      if (!conflictWarnedFor.has(conflictKey)) {
        conflictWarnedFor.add(conflictKey);
        // eslint-disable-next-line no-console
        console.warn(
          `[ac-emit] MEMEX_TEST_EVENTS_URL=${explicit} is overriding the ` +
            `default route for namespace "${namespace}" (would have gone to ` +
            `${canonicalUrl}). Events will land in the override, NOT the ` +
            `namespace's canonical destination.`,
        );
      }
    }
    logRoutingOnce(namespace, explicit);
    return explicit;
  }

  if (canonicalUrl) {
    logRoutingOnce(namespace, canonicalUrl);
    return canonicalUrl;
  }

  // A malformed ref with no namespace has nothing to route — skip it.
  if (!namespace) return null;

  // Namespace present but not in the explicit table: this is a SaaS tenant
  // (the common case for every customer). Default to memex.ai rather than
  // skipping — the destination server still validates the emission key against
  // the memex named in the ref, so a wrong guess is rejected there, not lost
  // here (spec-90 dec-7 / B1).
  const saasDefaultUrl = `${SAAS_DEFAULT_BASE_URL}/api/test-events`;
  logRoutingOnce(namespace, saasDefaultUrl);
  return saasDefaultUrl;
}
