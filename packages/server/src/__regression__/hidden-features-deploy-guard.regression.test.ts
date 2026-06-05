// spec-168 dec-4 — HIDDEN_FEATURES must not be silently clobbered on deploy.
//
// The Cloud Run deploy threads env vars through `--update-env-vars`, which is a
// MERGE. The bug this guards against: deploy.sh unconditionally emitted
// `HIDDEN_FEATURES=${HIDDEN_FEATURES}`, so a deploy from a checkout that never
// set the value blanked the live setting and silently un-hid soft-launch
// features (this is exactly how prod rev memex-api-00035 shipped un-hidden).
//
// The fix spans two files:
//   - scripts/deploy-config.sh exports HIDDEN_FEATURES ONLY when the per-env
//     config set it (preserving the unset-vs-explicitly-empty distinction).
//   - packages/server/deploy.sh appends the entry via ${HIDDEN_FEATURES+...},
//     so an UNSET value is omitted (live value preserved) while an explicitly
//     SET value — including an explicit empty string, a deliberate un-hide — is
//     applied verbatim.
//
// Covers:
//   ac-11: unset/absent => omitted from --update-env-vars (live value intact).
//   ac-12: explicitly set (incl. explicitly empty) => applied verbatim.
//   ac-13: this regression test asserts the conditional wiring in deploy.sh
//          (mirrors the MEMEX_OWN_NAMESPACE env-block regression test).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DEPLOY_SH = join(REPO_ROOT, "packages", "server", "deploy.sh");
const DEPLOY_CONFIG = join(REPO_ROOT, "scripts", "deploy-config.sh");

const SPEC = "mindset-prod/memex-building-itself/specs/spec-168";

// Reproduce the EXACT conditional expansion deploy.sh uses for the
// HIDDEN_FEATURES entry, run under `set -u` (bash -u) to prove it is safe when
// the variable is unset. Returns the rendered fragment (empty string when the
// entry is omitted).
function renderHiddenEntry(value: string | undefined): string {
  const script = `echo -n "\${HIDDEN_FEATURES+|HIDDEN_FEATURES=\${HIDDEN_FEATURES}}"`;
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (value === undefined) delete env.HIDDEN_FEATURES;
  else env.HIDDEN_FEATURES = value;
  return execSync(`bash -uc '${script}'`, { env }).toString();
}

describe("spec-168 ac-11: an UNSET HIDDEN_FEATURES is omitted (live value preserved)", () => {
  it("renders nothing when HIDDEN_FEATURES is unset — and is safe under `set -u`", () => {
    tagAc(`${SPEC}/acs/ac-11`);
    // No throw under bash -u proves the ${var+...} form is unbound-safe; the
    // empty result means the entry is omitted from --update-env-vars, so the
    // Cloud Run merge leaves whatever is already live untouched.
    expect(renderHiddenEntry(undefined)).toBe("");
  });
});

describe("spec-168 ac-12: an explicitly SET HIDDEN_FEATURES is applied verbatim", () => {
  it("renders the entry with the value when set to a slug list", () => {
    tagAc(`${SPEC}/acs/ac-12`);
    expect(renderHiddenEntry("scaffold,spec-pause,pulse")).toBe(
      "|HIDDEN_FEATURES=scaffold,spec-pause,pulse",
    );
  });

  it("renders an empty-valued entry when set to the empty string (deliberate un-hide)", () => {
    tagAc(`${SPEC}/acs/ac-12`);
    // Explicit empty is distinct from unset: it MUST emit the entry so the
    // deploy clears the live value (the documented un-hide path).
    expect(renderHiddenEntry("")).toBe("|HIDDEN_FEATURES=");
  });
});

describe("spec-168 ac-13: the conditional wiring is present in the deploy scripts", () => {
  it("deploy.sh appends HIDDEN_FEATURES via the guarded ${HIDDEN_FEATURES+...} form", () => {
    tagAc(`${SPEC}/acs/ac-13`);
    const src = readFileSync(DEPLOY_SH, "utf-8");
    // The guarded form must be present...
    expect(src).toMatch(
      /\$\{HIDDEN_FEATURES\+\|HIDDEN_FEATURES=\$\{HIDDEN_FEATURES\}\}/,
    );
    // ...and the OLD unconditional form (the entry NOT wrapped in ${...+...})
    // must be gone — i.e. `|HIDDEN_FEATURES=${HIDDEN_FEATURES}` only ever
    // appears inside the guard, never as a bare pipe-separated entry.
    const updateEnvLine = src
      .split("\n")
      .find((l) => l.includes("--update-env-vars"));
    expect(updateEnvLine).toBeDefined();
    expect(updateEnvLine!).not.toMatch(/\|HIDDEN_FEATURES=\$\{HIDDEN_FEATURES\}"/);
  });

  it("deploy-config.sh exports HIDDEN_FEATURES only when it is set (no force-default)", () => {
    tagAc(`${SPEC}/acs/ac-13`);
    const src = readFileSync(DEPLOY_CONFIG, "utf-8");
    // Conditional export gated on set-ness...
    expect(src).toMatch(/if\s+\[\s+-n\s+"\$\{HIDDEN_FEATURES\+set\}"\s+\]/);
    expect(src).toMatch(/export\s+HIDDEN_FEATURES\b/);
    // ...and the old unconditional default-to-empty must be gone.
    expect(src).not.toMatch(/export\s+HIDDEN_FEATURES="\$\{HIDDEN_FEATURES:-\}"/);
  });
});
