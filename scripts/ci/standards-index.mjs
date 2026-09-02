// The CLAUDE.md standards index is GENERATED (spec-512 dec-4).
//
//   node scripts/ci/standards-index.mjs --check   # staleness gate (offline lane)
//   node scripts/ci/standards-index.mjs --write   # regenerate  (`make standards-gen`)
//
// Why this exists: the index was hand-maintained, and it drifted — std-38, std-39,
// std-40, std-41 and std-42 were all approved in Memex and simply absent from the
// table agents orient from at session start. A Standard nobody can find from the
// codebase pointer is not binding anyone's behaviour. The pre-existing guard
// (spec-172-e2e-standard-index) pinned that ONE row (std-28) existed; nothing
// enforced completeness, so adding a Standard left the pointer stale with nothing red.
//
// Source of truth chain:
//   Memex (authoritative)  --agent, online-->  standards.manifest.json (committed)
//   standards.manifest.json  --this script-->  the CLAUDE.md table
//
// The manifest is the OFFLINE authority on purpose: CI holds no Memex credentials
// and the fast lane must not need the network. Manifest-vs-Memex drift is a
// separate online concern; an offline PR must never fail because a network call
// was unavailable.
//
// ── Marker handling ──────────────────────────────────────────────────────────
// This introduces the repo's FIRST BEGIN/END generated region (every other
// generated artifact here is whole-file with a prose banner), so it is written
// against the documented failure mode: a generator that rewrites only the FIRST
// marked block passes its own check while leaving the file broken. This one
// rewrites EVERY region and rejects duplicate, orphaned, unmatched or
// out-of-order markers rather than guessing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = "scripts/ci/standards-index.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLAUDE_MD = join(ROOT, "CLAUDE.md");
const MANIFEST = join(ROOT, "standards.manifest.json");

// Written into every generated manifest so the file explains itself to whoever
// opens it — including in memex-clients, where nobody has seen one before.
const MANIFEST_BANNER =
  "GENERATED-CONSUMED. The authoritative offline copy of the Memex standards index.";
const MANIFEST_REFRESH =
  "Refreshed from the LIVE Standard list by `--sync` (spec-544 dec-3) — no credential needed, the Memex is public. `repos` narrows a Standard to those repositories; ABSENT or empty means it binds every repo (fail-open, dec-2).";

export const BEGIN = "<!-- BEGIN generated: standards-index -->";
export const END = "<!-- END generated: standards-index -->";

/** Render the manifest as the markdown table body (no surrounding markers). */
export function renderTable(standards) {
  const lines = ["| Standard | Covers |", "|---|---|"];
  for (const s of standards) lines.push(`| ${s.handle} | ${s.summary} |`);
  return lines.join("\n");
}

// ── The live Standard list (spec-544 dec-3) ──────────────────────────────────
//
// Both repos are governed by the SAME Memex, so this is one constant, not a
// per-repo setting. The path grammar is std-10's; `include=tags` is an opt-in on
// the existing list route and is what makes attribution ride the same request as
// the handles (dec-1) — omit it and every row comes back with no `tags` key, which
// fail-open would then read as "binds every repo" for all 51.
export const LIVE_STANDARDS_URL =
  "https://memex.ai/api/mindset-prod/memex-building-itself/docs" +
  "?type=standard&include=tags";

/**
 * Read the live Standard list. UNAUTHENTICATED, deliberately.
 *
 * `fetch` is called with no init at all, so there is provably no Authorization
 * header to leak or expire. This Memex is public by design (std-31) and every GET
 * goes behind the permissive public session — public → read, private → 404 (std-7).
 * The generator's own header used to justify its offline mirror with "CI holds no
 * Memex credentials"; that was over-broad. Reading needs no credential, and
 * attaching one would couple a public read to a secret that can expire silently —
 * the failure dec-3 spent its whole resolution designing out.
 *
 * Returns the rows verbatim. Validation (array, non-empty) belongs to planIndex, so
 * there is ONE place that decides what a usable live list is.
 */
export async function fetchLiveStandards(url = LIVE_STANDARDS_URL) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `The live Standard list returned HTTP ${res.status} — refusing to plan.\n` +
        `  ${url}\n` +
        `  A private or renamed Memex answers 404 (std-7), which is indistinguishable\n` +
        `  from "zero Standards" — so this fails by status rather than handing the\n` +
        `  planner an empty list and reporting the wrong cause.\n` +
        `  Check: ${SELF}`,
    );
  }
  return res.json();
}

// ── Per-repo attribution (spec-544 dec-1 / dec-2) ────────────────────────────
//
// One Memex is the system of record for two repositories, and a Standard is
// attributed with FLAT tags — `memex-ai`, `memex-clients` — never a scoped
// `repo::` tag. A scoped value is mutually exclusive within its scope, and the
// both-repos set is a dozen Standards, so the attribute is a SET of repos.
//
// This list is not the "hand-maintained exclusion list" ac-3 forbids: that rule
// is about never hand-listing which STANDARDS to exclude. Knowing which repos
// exist is a different, tiny, stable thing — and the generator needs it anyway
// to know which indexes to render.
export const REPOS = ["memex-ai", "memex-clients"];

// Once each index is FILTERED (dec-2), "this index matches Memex" is false. The
// block has to claim only what it delivers, and point at the rest — otherwise a
// narrowed table reads as the whole rulebook.
export const INDEX_LEAD_IN =
  "_The Standards that bind this repo. The Memex holds more — " +
  "`search_memex({ memex: 'mindset-prod/memex-building-itself', kind: 'standard' })` " +
  "lists every one._";

/** The repos a live row is attributed to. Flat tags only (scope NULL); any other
 *  flat label a Standard happens to carry is ignored rather than read as a repo. */
function attributionOf(row) {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return tags
    .filter((t) => t && (t.scope === null || t.scope === undefined))
    .map((t) => t.value)
    .filter((v) => REPOS.includes(v));
}

function byHandleNumber(a, b) {
  return Number(a.handle.slice(4)) - Number(b.handle.slice(4));
}

/**
 * Render the table for ONE repo, failing open.
 *
 * An entry with no `repos` (or an empty one) binds every repo and is always
 * included — attribution only ever narrows, absence never hides (dec-2). Two real
 * callers share this: `planIndex` (from the live list) and the offline
 * check/write path (from the committed manifest). They MUST agree, or the offline
 * check would pass against a table the sync would immediately rewrite.
 */
export function renderForRepo(entries, repo) {
  const table = renderTable(
    entries.filter(
      (e) => !Array.isArray(e.repos) || e.repos.length === 0 || e.repos.includes(repo),
    ),
  );
  // The honest lead-in (ac-16). It lives INSIDE the generated block on purpose:
  // one source, and memex-clients inherits it without anyone writing prose there.
  // Naming an MCP call here is fine — CLAUDE.md is agent-facing prose, which
  // std-34 cl-14 excludes from the human-surface copy rule; the reader already
  // holds these tools.
  return `${INDEX_LEAD_IN}\n\n${table}`;
}

/**
 * Plan the manifest and one repo's index from the LIVE Standard list.
 *
 * The whole offline transformation behind one interface (std-51): merge live
 * handles into the manifest, seed the ones with no curated summary, derive
 * attribution, filter for `repo`, render the table. Pure — no network, no fs —
 * which is what keeps `make check` offline while this logic stays covered.
 *
 * Two behaviours here are deliberate and load-bearing:
 *
 *   SEED, NEVER BLOCK. A live handle with no manifest entry gets its live `title`
 *   as a provisional summary and is named in `seeded`. Refusing to generate until
 *   a human writes prose sounds stricter but fails worse: the red goes ambient or
 *   gets bypassed, and the Standard stays invisible — the exact harm spec-544
 *   exists to close. A curated summary is NEVER overwritten by the shorter title.
 *
 *   FAIL OPEN. A Standard with no attribution appears in EVERY repo's table.
 *   Attribution only ever narrows; absence never hides. Filtering that hid the
 *   unattributed would make one mis-tag erase a rule from both repos at once.
 */
export function planIndex({ live, manifest, repo }) {
  if (!Array.isArray(live)) {
    throw new Error(
      `The live Standard list is not an array (got ${typeof live}) — refusing to plan.\n` +
        `  A changed response shape must fail loud, not render an empty table.\n` +
        `  Check: ${SELF}`,
    );
  }
  if (live.length === 0) {
    throw new Error(
      `The live Standard list is EMPTY — refusing to generate anything.\n` +
        `  Zero live Standards is indistinguishable from a renamed Memex or one\n` +
        `  flipped to private (which returns 404 per std-7). Generating from it\n` +
        `  would blank the table every agent orients from.\n` +
        `  Check: ${SELF}`,
    );
  }

  const curated = new Map((manifest ?? []).map((s) => [s.handle, s.summary]));
  const seeded = [];
  const standards = live.map((row) => {
    const existing = curated.get(row.handle);
    if (existing === undefined) seeded.push(row.handle);
    return {
      handle: row.handle,
      summary: existing ?? row.title,
      repos: attributionOf(row),
    };
  });
  standards.sort(byHandleNumber);

  return { standards, seeded, table: renderForRepo(standards, repo) };
}

/** Locate every generated region. Throws with a contract-shaped message on any
 *  malformed marker rather than silently rewriting part of the file. */
export function findRegions(text) {
  const begins = [...text.matchAll(new RegExp(escapeRe(BEGIN), "g"))].map((m) => m.index);
  const ends = [...text.matchAll(new RegExp(escapeRe(END), "g"))].map((m) => m.index);

  if (begins.length !== ends.length) {
    throw new Error(
      `Unbalanced generated markers in CLAUDE.md — ${begins.length} BEGIN vs ${ends.length} END.\n` +
        `  An orphaned marker means a partial rewrite would corrupt the file, so nothing was written.\n` +
        `  Fix: restore the matching marker, or delete the orphan, then re-run:\n` +
        `    make standards-gen\n` +
        `  Check: ${SELF}`,
    );
  }
  if (begins.length === 0) {
    throw new Error(
      `No generated region found in CLAUDE.md.\n` +
        `  Expected a block delimited by:\n    ${BEGIN}\n    ${END}\n` +
        `  Fix: re-add the markers around the standards table, then run:\n` +
        `    make standards-gen\n` +
        `  Check: ${SELF}`,
    );
  }
  const regions = [];
  for (let i = 0; i < begins.length; i++) {
    if (ends[i] < begins[i]) {
      throw new Error(
        `Generated markers are out of order in CLAUDE.md (END at ${ends[i]} precedes BEGIN at ${begins[i]}).\n` +
          `  Fix: correct the marker order, then run:\n    make standards-gen\n` +
          `  Check: ${SELF}`,
      );
    }
    if (i > 0 && begins[i] < ends[i - 1]) {
      throw new Error(
        `Nested generated regions in CLAUDE.md (region ${i + 1} starts inside region ${i}).\n` +
          `  Fix: unnest the markers, then run:\n    make standards-gen\n` +
          `  Check: ${SELF}`,
      );
    }
    regions.push({ start: begins[i], end: ends[i] + END.length });
  }
  return regions;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rewrite EVERY generated region — never just the first. */
export function applyRegions(text, body) {
  const regions = findRegions(text);
  const block = `${BEGIN}\n${body}\n${END}`;
  let out = "";
  let cursor = 0;
  for (const r of regions) {
    out += text.slice(cursor, r.start) + block;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

// The files live in the repo being generated FOR — which is not always the repo
// this script lives in. Under dec-6 one composite action runs in each caller's own
// checkout, so `--root` points at that checkout; the default keeps every existing
// invocation (`make standards-check` / `-gen` in memex-ai) byte-identical.
function paths(root) {
  return {
    claudeMd: join(root, "CLAUDE.md"),
    manifest: join(root, "standards.manifest.json"),
  };
}

/** mode + repo + root, with `--repo` REQUIRED rather than defaulted.
 *  A silent default would generate memex-ai's index inside memex-clients and look
 *  like it worked — the ambiguous call errors instead (std-5's shape). */
function parseArgs(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const mode = argv.includes("--sync")
    ? "sync"
    : argv.includes("--write")
      ? "write"
      : "check";
  const repo = flag("--repo");
  if (!repo) {
    throw new Error(
      `--repo is required — every index is now scoped to one repository (spec-544 dec-2).\n` +
        `  Known repos: ${REPOS.join(", ")}\n` +
        `  Defaulting would silently generate the wrong repo's index and report success.\n` +
        `  e.g. node ${SELF} --check --repo memex-ai\n`,
    );
  }
  if (!REPOS.includes(repo)) {
    throw new Error(
      `Unknown --repo "${repo}". Known repos: ${REPOS.join(", ")}.\n` +
        `  A typo would render an index filtered to nothing but the unattributed\n` +
        `  Standards, which reads like a working (if short) table.\n` +
        `  Check: ${SELF}`,
    );
  }
  const root = flag("--root") ?? ROOT;
  // dec-7: the curated "Covers" prose has ONE home. `--root` is the repo being
  // generated FOR; `--curation` is where the curated manifest lives. Same
  // directory for the repo that owns its curation (memex-ai); different for every
  // other caller, whose run reads memex-ai's manifest out of the action's own
  // checkout and writes no manifest of its own.
  return { mode, repo, root, curation: flag("--curation") ?? root };
}

function loadManifest(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  const standards = parsed.standards ?? [];
  if (standards.length === 0) {
    throw new Error(
      `standards.manifest.json lists ZERO standards — refusing to generate an empty index.\n` +
        `  An empty manifest would silently blank the table agents orient from.\n` +
        `  Fix: refresh it from Memex (search_memex({kind:'standard'})), then:\n` +
        `    make standards-gen\n` +
        `  Check: ${SELF}`,
    );
  }
  return standards;
}

/** `--sync`: the ONLY mode that touches the network. Fetch the live list, plan,
 *  write the manifest, then fall through to `write` so the index follows. */
async function sync({ repo, root, curation }) {
  const { manifest: manifestPath } = paths(curation);
  const live = await fetchLiveStandards();
  // An absent manifest is a first run, not an error. A PRESENT but zero-standard
  // file still refuses, via loadManifest — that is corruption, not a cold start.
  let curated = [];
  if (existsSync(manifestPath)) curated = loadManifest(manifestPath);

  const { standards, seeded } = planIndex({ live, manifest: curated, repo });

  // dec-7: only the repo that OWNS the curation persists it. Elsewhere the
  // manifest we just read lives in the action's ephemeral checkout, so writing
  // there would be worse than pointless — the seeded summary would vanish with
  // the runner, and every run would re-seed and re-report the same placeholder
  // forever, while a second copy of the prose accumulated in another repo.
  const ownsCuration = curation === root;
  if (!ownsCuration) {
    process.stdout.write(
      `✓ live: ${standards.length} · curation read from ${manifestPath} ` +
        `(not written — this repo does not own it, dec-7)\n`,
    );
    if (seeded.length > 0) {
      process.stdout.write(
        `  ${seeded.length} of them have no curated summary yet and render their ` +
          `live title: ${seeded.join(", ")}\n` +
          `  Curate them in memex-ai's standards.manifest.json — that is the one home.\n`,
      );
    }
    // Hand the PLAN back rather than letting main() re-read the manifest: that
    // file belongs to another repo and does not carry the un-curated handles, so
    // re-reading it here would silently drop them from this repo's index — the
    // exact class of absence this Spec exists to end.
    return { standards };
  }

  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        "//": MANIFEST_BANNER,
        "//refresh": MANIFEST_REFRESH,
        standards,
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `✓ live: ${standards.length} · manifest ${existsSync(manifestPath) ? "updated" : "created"}\n`,
  );
  for (const h of seeded) {
    process.stdout.write(`+ ${h} … seeded from its live title\n`);
  }
  if (seeded.length > 0) {
    process.stdout.write(
      `\n⚠ ${seeded.length} ${seeded.length === 1 ? "summary is" : "summaries are"} ` +
        `a placeholder title — refine ${seeded.length === 1 ? "it" : "them"} in ` +
        `standards.manifest.json when you can. The rules are already visible; this is\n` +
        `  advisory, not a failure (spec-544 dec-3).\n\n`,
    );
  }
  return { standards };
}

async function main(argv) {
  const { mode, repo, root, curation } = parseArgs(argv);
  // CLAUDE.md is read and written in the repo being generated FOR; the curated
  // manifest is read from wherever curation lives (dec-7).
  const { claudeMd } = paths(root);
  const { manifest: manifestPath } = paths(curation);

  // In sync mode the plan IS the source — it carries the handles the curated
  // manifest has not seen yet. Re-reading the manifest would drop them.
  const planned = mode === "sync" ? await sync({ repo, root, curation }) : null;
  const standards = planned ? planned.standards : loadManifest(manifestPath);
  const current = readFileSync(claudeMd, "utf8");
  const next = applyRegions(current, renderForRepo(standards, repo));
  // What THIS repo's index should contain — not the whole Memex (dec-2).
  const expected = standards
    .filter(
      (s) => !Array.isArray(s.repos) || s.repos.length === 0 || s.repos.includes(repo),
    )
    .map((s) => s.handle);

  if (mode === "write" || mode === "sync") {
    if (next === current) {
      process.stdout.write(
        `✓ ${repo}: CLAUDE.md standards index already current (${expected.length} standards)\n`,
      );
      return 0;
    }
    writeFileSync(claudeMd, next);
    process.stdout.write(
      `✓ ${repo}: regenerated the CLAUDE.md standards index ` +
        `(${expected.length} of ${standards.length} standards bind this repo)\n`,
    );
    return 0;
  }

  if (next !== current) {
    const inFile = new Set(
      [...current.matchAll(/^\|\s*(std-\d+)\s*\|/gm)].map((m) => m[1]),
    );
    const inManifest = expected;
    const missing = inManifest.filter((h) => !inFile.has(h));
    const extra = [...inFile].filter((h) => !inManifest.includes(h));

    process.stderr.write(
      `CLAUDE.md STANDARDS INDEX IS STALE (spec-512 dec-4)\n` +
        `\n` +
        `  The generated table does not match standards.manifest.json.\n` +
        `  Manifest lists ${inManifest.length} standards; CLAUDE.md's table has ${inFile.size}.\n` +
        (missing.length
          ? `  Missing from CLAUDE.md: ${missing.join(", ")}\n`
          : "") +
        (extra.length ? `  In CLAUDE.md but not the manifest: ${extra.join(", ")}\n` : "") +
        (!missing.length && !extra.length
          ? `  Same handles, but one or more summaries differ.\n`
          : "") +
        `\n` +
        `  CLAUDE.md is how an agent discovers which rules bind it. A Standard that is\n` +
        `  approved but absent from this table is not binding anyone's behaviour.\n` +
        `\n` +
        `  Fix:\n` +
        `    make standards-gen\n` +
        `\n` +
        `  Check: ${SELF}\n`,
    );
    return 1;
  }

  process.stdout.write(
    `✓ ${repo}: CLAUDE.md standards index matches the manifest ` +
      `(${expected.length} of ${standards.length} standards bind this repo)\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`\n${err.message}\n`);
      process.exit(2);
    });
}
