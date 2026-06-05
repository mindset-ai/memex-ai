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

const conflictWarnedFor = new Set<string>();
const unknownWarnedFor = new Set<string>();
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
 * Returns null when the emission should be skipped (no namespace match AND
 * no explicit override). Callers MUST guard on null and skip the POST.
 *
 * Behaviour:
 * - `MEMEX_TEST_EVENTS_URL` set → use it. If it contradicts a known
 *   namespace mapping, emit a one-time conflict warning per (namespace,
 *   override-url) tuple.
 * - `NAMESPACE_TO_BASE_URL[namespace]` set → use the canonical URL.
 * - Otherwise → warn once per namespace and return null.
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

  if (namespace && !unknownWarnedFor.has(namespace)) {
    unknownWarnedFor.add(namespace);
    // eslint-disable-next-line no-console
    console.warn(
      `[ac-emit] namespace "${namespace}" has no known server mapping — ` +
        `skipping emission. Add the namespace to NAMESPACE_TO_BASE_URL in ` +
        `@memex-ai-ac/vitest, OR set MEMEX_TEST_EVENTS_URL to direct ` +
        `emissions explicitly.`,
    );
  }
  return null;
}
