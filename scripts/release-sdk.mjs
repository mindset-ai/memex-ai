#!/usr/bin/env node
// spec-222 t-14 (dec-9) — release:sdk. The explicit, repeatable PULL-release of the
// guide-sdk bundle to the marketing website. It:
//   1. builds the guide-sdk bundle (thin loader + hashed lazy chunks);
//   2. assembles the FULL dist into release/guide-sdk/ with a PROVENANCE stamp
//      recording the source memex-ai commit + version (the website repo can't
//      rebuild it, so the artifact must carry its origin);
//   3. with --open-pr, vendors it into the memex-website repo's js/ and opens a PR.
//
// The website serves the vendored bundle SAME-ORIGIN from its marketing bucket
// (gs://memex-ai-prod-marketing → https://www.memex.ai/js/…), NEVER from the
// app/SPA bucket (memex-app-spa-backend). The only runtime cross-origin call is to
// the /guide/v1 backend — exactly the pattern the site's waitlist already uses.
//
// This is a deliberate copy-and-deploy: memex-ai evolves guide-sdk on its own
// cadence; the website picks up a new build only when someone runs this and merges
// the PR. Versioned-API + N-1 back-compat (t-12) keep a not-yet-recopied bundle
// working against a newer server.

import { execSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  cpSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const openPr = args.has('--open-pr');

// ── per-host release targets (spec-251 t-7) ───────────────────────────────────
// The flow originally hard-coded the memex-website repo + its js/ + assets/
// layout. Each host site vendors the SAME dist but at its own destination, so
// the target carries: the env var pointing at a local checkout, how to vendor
// the staged dist into that checkout, and the serving contract recorded in
// provenance.json. `memex-website` stays the default and its behaviour is
// unchanged (spec-251 ac-13).
const targetArg = process.argv.slice(2).find((a) => a.startsWith('--target='));
const targetName = targetArg ? targetArg.slice('--target='.length) : 'memex-website';

const RELEASE_TARGETS = {
  'memex-website': {
    repoEnv: 'MEMEX_WEBSITE_REPO',
    repoLabel: 'memex-website',
    // Vendor the dist: loader + hashed chunks + provenance into js/, and the VAD
    // runtime assets into the site root's assets/ — the engine fetches them at
    // the absolute /assets/vad/ default (micVad baseAssetPath), not under /js/.
    vendor(websiteRepo, outDir) {
      const jsDir = resolve(websiteRepo, 'js');
      mkdirSync(jsDir, { recursive: true });
      for (const f of readdirSync(outDir)) {
        const dest = f === 'assets' ? resolve(websiteRepo, 'assets') : resolve(jsDir, f);
        cpSync(resolve(outDir, f), dest, { recursive: true });
      }
      return 'js/ assets/';
    },
    // The serving contract (dec-9): marketing bucket, same-origin, NOT the SPA bucket.
    servedFrom:
      'gs://memex-ai-prod-marketing → https://www.memex.ai/js/ (marketing bucket; NOT memex-app-spa-backend)',
    embed: '<script type="module" src="/js/memex-guide.js"></script>',
    // The engine's Silero VAD loads these same-origin from /assets/vad/ (micVad
    // default); vendor assets/vad/ alongside the bundle into the website's /assets/.
    vadAssets: 'assets/vad/ → served same-origin at /assets/vad/',
  },
  'mindset-website': {
    repoEnv: 'MINDSET_WEBSITE_REPO',
    repoLabel: 'mindset-website',
    // The spec-2 contract (mindset-prod/mindset-website): the FULL dist —
    // loader + hashed chunks + assets (incl. VAD) + provenance — lands under
    // public/guide/, served same-origin at /guide/.
    vendor(websiteRepo, outDir) {
      const guideDir = resolve(websiteRepo, 'public/guide');
      mkdirSync(guideDir, { recursive: true });
      for (const f of readdirSync(outDir)) {
        cpSync(resolve(outDir, f), resolve(guideDir, f), { recursive: true });
      }
      return 'public/guide/';
    },
    servedFrom: 'mindset-ai/mindset-website public/guide/ → https://www.mindset.ai/guide/ (same-origin)',
    embed: '<script type="module" src="/guide/memex-guide.js"></script>',
    vadAssets:
      'public/guide/assets/vad/ → served same-origin at /guide/assets/vad/ (configure the engine baseAssetPath; the /assets/vad/ default assumes the memex-website layout)',
  },
};

const target = RELEASE_TARGETS[targetName];
if (!target) {
  console.error(
    `release:sdk · unknown --target=${targetName} (expected one of: ${Object.keys(RELEASE_TARGETS).join(', ')}).`,
  );
  process.exit(1);
}

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: repoRoot, encoding: 'utf8', ...opts }).toString().trim();

// ── 1. build the bundle ────────────────────────────────────────────────────────
if (!skipBuild) {
  console.log('release:sdk · building guide-sdk bundle…');
  execSync('pnpm --filter @memex/guide-sdk build:bundle', { cwd: repoRoot, stdio: 'inherit' });
}

const bundleDir = resolve(repoRoot, 'packages/guide-sdk/dist-bundle');
if (!existsSync(bundleDir)) {
  console.error('release:sdk · no dist-bundle/ — run without --skip-build first.');
  process.exit(1);
}

// ── 2. assemble release/ with a provenance stamp ────────────────────────────────
const outDir = resolve(repoRoot, 'release/guide-sdk');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(bundleDir, outDir, { recursive: true });

// The engine's Silero VAD loads its ONNX model + onnxruntime WASM from
// /assets/vad/ (micVad.ts default). The website must serve those alongside the
// bundle, so vendor them too. They stage under packages/ui/public/assets/vad via
// the ui `vad:assets` script (the canonical copy of the @ricky0123/vad-web +
// onnxruntime-web binaries); ensure they're present, then copy into the release.
const vadSrc = resolve(repoRoot, 'packages/ui/public/assets/vad');
if (!existsSync(vadSrc) || readdirSync(vadSrc).length === 0) {
  console.log('release:sdk · staging VAD assets (ui vad:assets)…');
  execSync('pnpm --filter @memex/ui vad:assets', { cwd: repoRoot, stdio: 'inherit' });
}
const vadOut = resolve(outDir, 'assets/vad');
mkdirSync(vadOut, { recursive: true });
cpSync(vadSrc, vadOut, { recursive: true });

const pkg = JSON.parse(
  readFileSync(resolve(repoRoot, 'packages/guide-sdk/package.json'), 'utf8'),
);
const sourceCommit = sh('git rev-parse HEAD');
const sourceRef = (() => {
  try {
    return sh('git rev-parse --abbrev-ref HEAD');
  } catch {
    return 'unknown';
  }
})();
const files = readdirSync(outDir).filter((f) => f !== 'provenance.json');
const loader = files.find((f) => f === 'memex-guide.js');

const provenance = {
  name: '@memex/guide-sdk',
  version: pkg.version,
  sourceRepo: 'memex-ai',
  sourceCommit,
  sourceRef,
  builtAt: new Date().toISOString(),
  entry: loader ?? null,
  files,
  // The serving contract for THIS target (dec-9; per-host since spec-251).
  target: targetName,
  servedFrom: target.servedFrom,
  embed: target.embed,
  vadAssets: target.vadAssets,
};
writeFileSync(resolve(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);

console.log(
  `release:sdk · staged ${files.length} file(s) → release/guide-sdk/ ` +
    `(entry ${loader ?? '??'}, source ${sourceCommit.slice(0, 12)})`,
);

// ── 3. (optional) vendor into the target host repo + open a PR ────────────────────
if (openPr) {
  const websiteRepo = process.env[target.repoEnv];
  if (!websiteRepo || !existsSync(websiteRepo)) {
    console.error(
      `release:sdk · --open-pr needs ${target.repoEnv} pointing at a checkout of the ${target.repoLabel} repo.`,
    );
    process.exit(1);
  }
  const branch = `sdk-release-${sourceCommit.slice(0, 12)}`;
  const addPaths = target.vendor(websiteRepo, outDir);
  const g = (cmd) => execSync(cmd, { cwd: websiteRepo, stdio: 'inherit' });
  g(`git checkout -b ${branch}`);
  g(`git add ${addPaths}`);
  g(`git commit -m "chore(sdk): vendor guide-sdk bundle @ ${sourceCommit.slice(0, 12)}"`);
  g(`git push -u origin ${branch}`);
  g(
    `gh pr create --title "Vendor guide-sdk bundle @ ${sourceCommit.slice(0, 12)}" ` +
      `--body "Automated release:sdk from memex-ai@${sourceCommit}. ${target.servedFrom}"`,
  );
  console.log(`release:sdk · opened PR on ${target.repoLabel} (branch ${branch}).`);
}
