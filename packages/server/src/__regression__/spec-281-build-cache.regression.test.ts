// spec-281 Fix 2 + ac-5 — the server container build is layer-cached, and both
// spec-281 fixes ride the SHARED, env-keyed deploy path (so int + prod get them
// identically). Static assertions in the shape of the repo's other deploy-wiring
// guards (handhold-backfill, default-standards, cicd-deploy-config): they fail if
// the wiring that makes the scope ACs true is ever removed.
//
// ac-4: the build pulls the previous image and builds `--cache-from` it with
//       BuildKit inline cache, so an unchanged-deps build reuses the pnpm-install
//       layers instead of rebuilding from scratch. The root Dockerfile is already
//       staged so the `deps` layer stays cacheable when only source changes — this
//       guard pins both halves (the cloudbuild wiring AND the Dockerfile staging
//       the cache depends on). Actual layer reuse is additionally demonstrated with
//       a local `docker build` twice in the build session, and confirmed live on the
//       next deploy.
// ac-5: both fixes live in the shared, non-env-conditional deploy path
//       (apply-hand-migrations.sh + cloudbuild.yaml/deploy.sh build step), and CI
//       runs the same `bash deploy.sh` — no environment-specific divergence.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-281";
const AC4 = `${SPEC}/acs/ac-4`;
const AC5 = `${SPEC}/acs/ac-5`;

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), "utf-8");

const cloudbuild = read("cloudbuild.yaml");
const serverDeploy = read("packages", "server", "deploy.sh");
const rootDockerfile = read("Dockerfile");
const deployWorkflow = read(".github", "workflows", "deploy.yml");

describe("spec-281 ac-4: the server container build reuses cached layers", () => {
  it("cloudbuild.yaml seeds the cache from the previously-pushed image (--cache-from)", () => {
    tagAc(AC4);
    // Pull the prior image first (non-fatal on a cold/first build)...
    expect(cloudbuild).toMatch(/docker pull "\$\{_IMAGE\}:latest"\s*\|\|/);
    // ...and build using it as the cache source.
    expect(cloudbuild).toMatch(/--cache-from=\$\{_IMAGE\}:latest/);
  });

  it("stamps BuildKit inline-cache metadata so the NEXT deploy can reuse these layers", () => {
    tagAc(AC4);
    expect(cloudbuild).toMatch(/BUILDKIT_INLINE_CACHE=1/);
    expect(cloudbuild).toMatch(/DOCKER_BUILDKIT=1/);
    // The built, cache-stamped image is actually pushed.
    expect(cloudbuild).toMatch(/images:[\s\S]*\$\{_IMAGE\}:latest/);
    // Builds the workspace-aware root Dockerfile.
    expect(cloudbuild).toMatch(/--file=Dockerfile/);
  });

  it("deploy.sh builds via the cache config, not the cacheless bare `--tag`", () => {
    tagAc(AC4);
    expect(serverDeploy).toMatch(/gcloud builds submit\s+\\\s*\n\s*--config cloudbuild\.yaml/);
    expect(serverDeploy).toMatch(/--substitutions "_IMAGE=\$\{IMAGE\}"/);
    // The old cacheless invocation is gone — `gcloud builds submit --tag "${IMAGE}"`.
    expect(serverDeploy).not.toMatch(/gcloud builds submit\s+\\\s*\n\s*--tag "\$\{IMAGE\}"/);
  });

  it("the Dockerfile's deps stage is staged for cache reuse: manifests + lockfile copied and installed BEFORE source", () => {
    tagAc(AC4);
    // The cache only helps if `pnpm install` sits in a layer keyed on the lockfile /
    // package.jsons, ABOVE the source copy — so a source-only change leaves it cached.
    const depsInstall = rootDockerfile.search(/RUN pnpm install --frozen-lockfile --ignore-scripts/);
    const srcCopy = rootDockerfile.search(/COPY packages\/server\/src/);
    expect(depsInstall).toBeGreaterThanOrEqual(0);
    expect(srcCopy).toBeGreaterThan(depsInstall); // source copied after the install layer
  });
});

describe("spec-281 ac-5: both fixes ride the shared env-keyed deploy path", () => {
  it("the batched applied-check lives in the shared, non-env-conditional migration script", () => {
    tagAc(AC5);
    const migrate = read("packages", "server", "scripts", "apply-hand-migrations.sh");
    expect(migrate).toMatch(/SELECT filename FROM manual_migrations/);
    // No environment branching in the script — one code path for int + prod.
    expect(migrate).not.toMatch(/\$\{?ENV\b/);
  });

  it("the cache config is env-agnostic — parameterised only by the env-keyed _IMAGE substitution", () => {
    tagAc(AC5);
    // No hardcoded int/prod project, host, or region baked into the build config.
    expect(cloudbuild).not.toMatch(/memex-ai-(int|prod)/);
    expect(cloudbuild).not.toMatch(/int\.memex\.ai/);
    expect(cloudbuild).toMatch(/\$\{_IMAGE\}/);
  });

  it("CI runs the same bash deploy.sh, so both fixes execute on every int + prod deploy", () => {
    tagAc(AC5);
    expect(deployWorkflow).toMatch(/bash deploy\.sh/);
  });
});
