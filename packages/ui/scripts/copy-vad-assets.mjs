// spec-190 t-8/dec-8 — stage the Silero VAD runtime assets into public/vad so
// they're served at /vad/ for the browser AudioWorklet (the local speech-onset
// detector, ac-23). Runs on predev + prebuild so both `pnpm dev` and `pnpm build`
// (incl. the CI/deploy build) have the assets without committing ~14MB of binary
// (.onnx model + onnxruntime-web .wasm) into git.
//
// What gets copied:
//   - @ricky0123/vad-web: the AudioWorklet bundle + the Silero ONNX models
//   - onnxruntime-web:     the wasm backend files the worklet loads at runtime
//
// Idempotent: skips a file already present with the same byte size. Resolves
// sources from node_modules via require.resolve so it survives pnpm's nested
// layout and version bumps.

import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_VAD = join(here, "..", "public", "vad");

// vad-web dist (main = dist/index.js → its dir).
const vadDist = dirname(require.resolve("@ricky0123/vad-web"));
// onnxruntime-web — resolve via the `onnxruntime-web/wasm` subpath that vad-web
// itself imports (its `exports` map blocks `./package.json`). Resolve relative to
// vad-web since ort is vad-web's runtime dep, not a direct dep of @memex/ui under
// pnpm's strict layout. The resolved file lives in ort's dist/.
const ortDist = dirname(require.resolve("onnxruntime-web/wasm", { paths: [vadDist] }));

mkdirSync(PUBLIC_VAD, { recursive: true });

function copy(srcFile) {
  const dest = join(PUBLIC_VAD, basename(srcFile));
  if (existsSync(dest) && statSync(dest).size === statSync(srcFile).size) return false;
  copyFileSync(srcFile, dest);
  return true;
}

let copied = 0;

// 1. The AudioWorklet processor bundle + the Silero v5 ONNX model (vad-web). We
//    pin v5 (the engine default); the legacy model is not shipped — flip the
//    engine's `model` option AND add it here together if ever needed.
for (const name of ["vad.worklet.bundle.min.js", "silero_vad_v5.onnx"]) {
  const src = join(vadDist, name);
  if (!existsSync(src)) {
    console.error(`[copy-vad-assets] missing expected vad-web asset: ${src}`);
    process.exit(1);
  }
  if (copy(src)) copied++;
}

// 2. The onnxruntime-web wasm backend. vad-web runs the Silero model on the CPU
//    wasm EP (no WebGPU/WebNN), so only the SIMD+threaded build is needed — NOT
//    the jsep (GPU), asyncify, or jspi variants (~64MB of those, skipped to keep
//    the deploy bundle lean). REAL-DEVICE CHECK: if VAD init 404s fetching a
//    different ort-wasm-*.wasm, add that exact variant here (watch the network tab).
const ORT_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];
for (const f of ORT_FILES) {
  const src = join(ortDist, f);
  if (!existsSync(src)) {
    console.error(`[copy-vad-assets] missing expected onnxruntime-web asset: ${src}`);
    console.error(`  (available: ${readdirSync(ortDist).filter((x) => x.startsWith("ort-wasm")).join(", ")})`);
    process.exit(1);
  }
  if (copy(src)) copied++;
}

const expected = 2 + ORT_FILES.length;
console.log(
  `[copy-vad-assets] ${copied} file(s) staged into public/vad (${expected} expected; rest already current).`,
);
