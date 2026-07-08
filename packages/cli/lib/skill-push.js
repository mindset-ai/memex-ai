// lib/skill-push.js — `memex-ai skill push <dir>` (spec-300 issue-6b).
//
// Upload a local SKILL.md package (a SKILL.md plus its auxiliary files) to a Memex as
// a new Skill. Binary bytes ride as raw multipart parts (global FormData + Blob +
// fetch, Node 18+) — NO base64-in-JSON. Authenticated with the single user checkout
// key from ~/.memex/checkout.json (the same credential the edit hook uses), which the
// server accepts on the skills create route (spec-300 issue-5).
//
// Zero dependencies: Node built-ins + globals only (std-24). All IO (fetch, fs) is
// injectable so the orchestration unit-tests offline.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { storePath, loadStore, keyFromStore } from "./checkout-bootstrap.js";

const DEFAULT_FS = {
  readFile: (p) => readFileSync(p),
  readdir: (p) => readdirSync(p, { withFileTypes: true }),
  stat: (p) => statSync(p),
};

// Content-type by file extension, so the server's text-vs-binary storage split lands
// text files inline and everything else as bytes. Unknown → octet-stream (binary).
const TEXT_TYPES = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  csv: "text/csv",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  jsx: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};
const BINARY_TYPES = {
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function contentTypeFor(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return TEXT_TYPES[ext] ?? BINARY_TYPES[ext] ?? "application/octet-stream";
}

// Parse + validate a `<namespace>/<memex>` target. Throws a clear error otherwise.
export function parseMemexTarget(memex) {
  if (typeof memex !== "string" || !memex.includes("/")) {
    throw new Error("`--memex <namespace>/<memex>` is required (e.g. --memex acme/handbook).");
  }
  const parts = memex.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid --memex "${memex}" — expected the form <namespace>/<memex>.`);
  }
  return { namespace: parts[0], memexSlug: parts[1] };
}

// Recursively collect every file under `dir` except the root SKILL.md, returning
// { relPath, bytes } with POSIX-style relative paths (the server stores slashes).
function collectAuxFiles(dir, fs) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdir(current)) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, full).split(sep).join("/");
      if (rel === "SKILL.md") continue; // the primary is the skillMd part, not an aux file
      out.push({ relPath: rel, bytes: fs.readFile(full) });
    }
  };
  walk(dir);
  return out;
}

/**
 * Push the SKILL.md package in `dir` to `<apiBase>/api/<ns>/<mx>/skills` as multipart.
 * Returns the created skill's canonical ref. Throws a clear Error on any failure
 * (missing key, missing SKILL.md, non-2xx response).
 */
export async function skillPush({ dir, memex, apiBase, deps = {} }) {
  const fs = deps.fs ?? DEFAULT_FS;
  const fetchImpl = deps.fetch ?? fetch;

  if (!dir) throw new Error("A skill directory is required: `memex-ai skill push <dir>`.");
  const { namespace, memexSlug } = parseMemexTarget(memex);

  // The checkout key (single user key) — the same credential the edit hook uses.
  const store = loadStore(deps.storePath ?? storePath(), deps.storeFs);
  const key = keyFromStore(store);
  if (!key) {
    throw new Error(
      "No checkout key found in ~/.memex/checkout.json. Run `memex-ai checkout-setup` (or `install`) first.",
    );
  }

  // Read the primary SKILL.md.
  const skillMdPath = join(dir, "SKILL.md");
  let skillMd;
  try {
    skillMd = fs.readFile(skillMdPath).toString("utf8");
  } catch {
    throw new Error(`No SKILL.md found in ${dir}. A skill package must contain a SKILL.md.`);
  }
  if (!skillMd.trim()) throw new Error(`${skillMdPath} is empty.`);

  const auxFiles = collectAuxFiles(dir, fs);

  // Build the multipart body. Do NOT set Content-Type — the runtime derives the
  // multipart boundary from the FormData instance.
  const form = new FormData();
  form.set("skillMd", skillMd);
  form.set("filename", "SKILL.md");
  for (const f of auxFiles) {
    const type = contentTypeFor(f.relPath);
    form.append("files", new Blob([f.bytes], { type }), f.relPath);
  }

  const url = `${apiBase}/api/${namespace}/${memexSlug}/skills`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Skill push failed (${res.status} ${res.statusText}): ${detail}`);
  }
  const json = await res.json().catch(() => ({}));
  return { ref: typeof json.ref === "string" ? json.ref : null, fileCount: auxFiles.length };
}
