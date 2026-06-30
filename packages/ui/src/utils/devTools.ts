// spec-226 t-6 (dec-3) — client-side gate for the internal email-preview gallery.
//
// The gallery (and its nav entry + route) is reachable on local + int, NEVER on
// prod — mirroring the server mount gate (routes/__dev__.ts shouldMountDevTools).
// The prod app is served from the apex `memex.ai` (int is `int.memex.ai`, local is
// `localhost`), so "not prod" is "hostname is not the prod app host". Even if this
// gate were wrong, the server route is unmounted on prod (404) — this is defence in
// depth for the page itself, which ac-6 requires not be reachable on prod.
const PROD_APP_HOSTS = new Set(["memex.ai", "www.memex.ai"]);

export function emailPreviewEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return !PROD_APP_HOSTS.has(window.location.hostname);
}
