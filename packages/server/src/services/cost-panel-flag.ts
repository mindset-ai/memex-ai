// spec-552 t-2 (dec-8) — the staged-rollout gate for the per-Memex cost panel.
//
// Shape borrowed deliberately from services/email/activation-flag.ts: an
// EXPLICIT env var, read LIVE (never cached), trimmed, case-insensitive. There
// is one flag idiom in this codebase and this is it.
//
// What it holds — a comma-separated allowlist of memex refs, NOT a boolean:
//
//   unset · empty · whitespace   →  NOBODY sees the panel
//   "mindset-prod/memex-x"       →  that Memex only
//   "a/b, c/d"                   →  both
//   "*"                          →  every Memex, including ones created later
//
// A list rather than a boolean because a boolean would have to name the
// dogfood Memex somewhere, and the only place to name it is product code
// shipped to every customer — where it becomes dead weight the moment the
// rollout completes. The dogfood round is a fact about our deployment, so it
// lives in the deployment's configuration (dec-8).
//
// DEFAULT CLOSED is the load-bearing property. A forgotten, mistyped or
// unrecognised value hides the card; it never releases it early. Every flag in
// this codebase defaults off, and an "unset means everyone" reading here would
// make a misconfigured deploy the most exposed one.
//
// This module only DECIDES. Enforcement belongs where the data is produced
// (spec-552 t-3): a Memex outside the list never receives the figures, so
// hiding the card is not something a client could decline to do.

const ENV_VAR = "COST_PANEL_MEMEXES";

/** The wildcard that opens the panel to every Memex. */
const ALL = "*";

/**
 * The allowlist as configured, normalised: trimmed, lower-cased, empty entries
 * dropped. Exported for the readout in tests and diagnostics; callers deciding
 * access should use {@link costPanelEnabledFor} so the wildcard and the
 * default-closed rule are applied in one place.
 */
export function costPanelAllowlist(): string[] {
  return (process.env[ENV_VAR] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether this Memex may see the cost panel.
 *
 * Takes the namespace and memex slugs SEPARATELY — the caller has them from
 * the resolved request, and keeping them apart means no caller can accidentally
 * pass a document ref (`ns/mx/specs/spec-1`) and match a prefix. Matching is
 * always against the server-resolved identity, never a caller-supplied string
 * (dec-8).
 *
 * Read live on every call: flipping the env var takes effect on the next
 * request with no restart, exactly as activation-flag.ts behaves.
 */
export function costPanelEnabledFor(namespace: string, memex: string): boolean {
  const allowlist = costPanelAllowlist();
  if (allowlist.length === 0) return false; // default closed
  if (allowlist.includes(ALL)) return true;

  const ns = namespace.trim().toLowerCase();
  const mx = memex.trim().toLowerCase();
  // A blank identity can never match — otherwise an unresolved request would
  // compare "/" against the list and a stray "/" entry would open the gate.
  if (ns.length === 0 || mx.length === 0) return false;

  return allowlist.includes(`${ns}/${mx}`);
}
