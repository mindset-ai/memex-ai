// b-68 t-16: drift-guard regression test for the unified Scaffold model.
//
// Asserts the five structural invariants from b-68 dec-6 ("one model, many
// projections"). Each invariant carries `tagAc(ac-20)` so the AC-emit pipeline
// flips the AC to verified on a green run and to failing the moment any
// structural drift sneaks in.
//
// Invariants pinned here:
//
//   (a) Prompt prose is owned by `scaffold-data.ts`. The two deferred
//       residual `.md` files (`_base/code-grounding.md`,
//       `_base/standards-protocol.md`) plus `phases/creation/system.md`
//       are allowlisted. Any NEW `.md` under `phases/` or any new
//       multi-line markdown-shaped string literal in `packages/server/src`
//       or `packages/ui/src` (outside `scaffold-data.ts`) fails.
//
//   (b) Every (tool × phase) pair resolves to a string via `toNudge`.
//       Empty strings are fine, but the call must never throw.
//
//   (c) Every PhaseNode declares at least one `promptBlockId`; every id
//       resolves to a `react_only` PromptBlockNode in `promptBlocks`.
//
//   (d) Every base node (PhaseNode, PromptBlockNode, ToolNode,
//       TransitionRubric, and `source:'base'` GuidanceBlock) carries a
//       non-empty rationale string.
//
//   (e) `org_scaffold_additions` has NO `source` column (dec-3: the table
//       IS the discriminator), and `CreateOrgScaffoldAdditionInput` does
//       not expose a `source` field on the type — there's no write path
//       that could land a `source:'base'` row.
//
// Plus: b-67's manifest ↔ Zod parity regression test still exists and
// passes (we re-export-check its assertion to keep the drift-guard fail
// loud if that test goes missing).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  BASE_SCAFFOLD,
  toNudge,
  type GuidanceBlock,
  type PhaseNode,
  type PromptBlockNode,
  type ToolNode,
  type TransitionRubric,
} from "@memex/shared";
import { orgScaffoldAdditions } from "../db/schema.js";
import type { CreateOrgScaffoldAdditionInput } from "../services/scaffold-additions.js";

const AC_20 = "mindset-prod/memex-building-itself/briefs/b-68/acs/ac-20";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const SERVER_SRC = join(REPO_ROOT, "packages", "server", "src");
const ADMIN_SRC = join(REPO_ROOT, "packages", "ui", "src");
const SHARED_SCAFFOLD_DATA = join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "scaffold-data.ts",
);
const SERVER_PHASES_DIR = join(SERVER_SRC, "agent", "phases");

// Allowlisted residual `.md` files under `phases/`. These are deferred
// migrations that t-6/t-7 left on disk because the runtime still reads them.
// Any NEW `.md` under this tree fails (a) — surface the file so the author
// either deletes it or moves it into `scaffold-data.ts`.
const ALLOWLISTED_PHASE_MDS = new Set([
  join("_base", "code-grounding.md"),
  join("_base", "standards-protocol.md"),
  join("creation", "system.md"),
]);

// Allowlisted code files carrying prose by design — these are NOT agent
// system-prompt / nudge / rubric content (those live in scaffold-data.ts).
// They are user-facing "Init Prompt" templates (pasted into a fresh coding
// agent by a human) and one-shot seed data. The drift-guard invariant is
// "no NEW agent-prompt prose leaks outside scaffold-data" — these existing
// non-system-prompt surfaces are the analogue of the `.md` residue under
// `phases/`. Any NEW file outside this list that grows agent-prompt prose
// must move into scaffold-data.ts.
//
// Each entry is a workspace-relative path (POSIX-style separators); they
// are normalised to OS separators before comparison.
const ALLOWLISTED_PROSE_FILES = new Set(
  [
    // Init Prompt templates — rendered into a clipboard string for the human
    // to paste into a coding agent. Not consumed by Mindset's own agent.
    "packages/ui/src/utils/specInitPrompt.ts",
    "packages/ui/src/utils/taskInitPrompt.ts",
    // spec-201: the "Genesis prompt" — clipboard text a human pastes into a
    // fresh Claude Code / Cursor session to wire their own agent up to Memex
    // (register the MCP server + write a CLAUDE.md / .cursor rule). Same
    // category as the Init Prompts above: human-pasted, NOT consumed by
    // Mindset's own agent, so it belongs here rather than in scaffold-data.ts
    // (which owns Mindset-agent system-prompt / nudge / rubric prose).
    "packages/ui/src/utils/genesisPrompt.ts",
    // One-shot Postgres seed for the b-3 "reviewer" persona — bootstrap
    // data, not a runtime nudge channel.
    "packages/server/src/db/seed-reviewer.ts",
    // The MCP server's `instructions` payload is the orientation surface
    // for the MCP agent itself (the analogue of the React `role` block).
    // Treated as part of the system-prompt surface in the same way the
    // CLAUDE.md / scaffold model's `role` block is — kept here until t-7's
    // final pass migrates the MCP `instructions` payload into scaffold-data
    // alongside `role`. Logged as expected residue; remove this entry once
    // the migration lands.
    "packages/server/src/mcp/tools.ts",
    // spec-178: the Handhold demo fixture embeds spec-64's VERBATIM content as
    // multi-line markdown template literals (HANDHOLD_SECTIONS) — by design (ac-2,
    // wording unchanged). It is frozen DEMO CONTENT seeded into a personal Memex,
    // not agent-prompt prose / a nudge channel, so it does not belong in
    // scaffold-data.ts. Exempt the fixture from the prose-location guard.
    "packages/server/src/db/handhold-demo.fixture.ts",
  ].map((p) => p.split("/").join(sep)),
);

// ──────────────────────────────────────────────────────────────────────────
// Helpers.
// ──────────────────────────────────────────────────────────────────────────

function walkFiles(root: string, match: (path: string) => boolean): string[] {
  const out: string[] = [];
  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        // Skip generated / vendored / test trees — drift policy applies to
        // hand-authored source only.
        if (
          name === "node_modules" ||
          name === "dist" ||
          name === "build" ||
          name === "__regression__" ||
          name === "__smoke__" ||
          name === "test" ||
          name === "tests" ||
          name === ".turbo" ||
          name === "coverage"
        ) {
          continue;
        }
        recurse(full);
      } else if (stats.isFile() && match(full)) {
        out.push(full);
      }
    }
  }
  recurse(root);
  return out;
}

function listPhaseMarkdownFiles(): string[] {
  return walkFiles(SERVER_PHASES_DIR, (p) => p.endsWith(".md"));
}

// Multi-line template-literal extractor. Scans for backtick-delimited
// template literals that span at least 2 newlines, then keeps only those
// whose body looks like markdown prose (a `## ` heading, a `- ` bullet at
// line start, OR agent-directed verbs in the imperative voice).
//
// Deliberately conservative: short backtick strings, regex patterns, SQL
// fragments, and stack traces don't match. False positives would corrode
// the drift guard's signal, so the heuristic favours under-flagging here
// — the invariant is "no NEW prompt prose leaks in", not "no markdown
// anywhere ever".
const AGENT_VERB_PATTERN =
  /\b(you (must|should|are)|never (call|use|pass|claim)|always (call|use|cite|search)|use\s+`?[a-z_]+\(`?|call\s+`?[a-z_]+\(`?)\b/i;

function extractMarkdownTemplateLiterals(src: string): string[] {
  const matches: string[] = [];
  // Non-greedy backtick run capturing everything until the next unescaped
  // backtick. Sufficient for source files where template literals are
  // formed at module / function scope. We strip escaped backticks before
  // counting newlines so `\`` inside the body doesn't terminate early.
  const re = /`([^`\\]*(?:\\.[^`\\]*)*)`/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = m[1];
    const newlines = (body.match(/\n/g) ?? []).length;
    if (newlines < 2) continue;
    const looksLikeMarkdown =
      /(^|\n)##\s/.test(body) ||
      /(^|\n)-\s/.test(body) ||
      AGENT_VERB_PATTERN.test(body);
    if (looksLikeMarkdown) matches.push(body);
  }
  return matches;
}

// String-concatenation prose extractor. Catches the `'## Heading\n' + '- ' +
// 'bullet'` shape — agent-prose authors often use this idiom inside record
// literals (scaffold-data.ts itself does, hence the allowlist).
//
// We look for an open-quote followed by `## ` or `- ` at the very start of
// the literal — anchored to the quote so we don't pick up incidental `## `
// inside arbitrary strings.
const CONCAT_PROSE_PATTERN =
  /(['"])(##\s[^'"]{8,}|-\s[A-Z][^'"]{8,})\1\s*\+/;

function fileContainsConcatProse(src: string): boolean {
  return CONCAT_PROSE_PATTERN.test(src);
}

function readSrcFiles(root: string): Array<{ path: string; src: string }> {
  return walkFiles(root, (p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    .filter(
      (p) =>
        !p.endsWith(".test.ts") &&
        !p.endsWith(".test.tsx") &&
        !p.endsWith(".integration.test.ts") &&
        !p.endsWith(".d.ts"),
    )
    .map((path) => ({ path, src: readFileSync(path, "utf-8") }));
}

// ──────────────────────────────────────────────────────────────────────────
// (a) No prompt prose lives outside scaffold-data.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 drift-guard: prompt prose location (ac-20 (a))", () => {
  it("no NEW .md files under server/src/agent/phases beyond the deferred allowlist", () => {
    tagAc(AC_20);
    const found = listPhaseMarkdownFiles().map((p) =>
      relative(SERVER_PHASES_DIR, p).split(sep).join(sep),
    );
    // `.ORPHAN` suffix files are migration sentinels — also tolerated.
    const real = found.filter((p) => !p.endsWith(".ORPHAN"));
    const unexpected = real.filter((p) => !ALLOWLISTED_PHASE_MDS.has(p));
    expect(
      unexpected,
      unexpected.length
        ? `NEW prompt-prose .md files appeared under phases/:\n  - ${unexpected.join(
            "\n  - ",
          )}\nMove them into packages/shared/src/scaffold-data.ts as PromptBlockNode / GuidanceBlock records.`
        : "",
    ).toEqual([]);
  });

  it("no inline string-literal prompt prose outside scaffold-data.ts (server + admin)", () => {
    tagAc(AC_20);
    const files = [...readSrcFiles(SERVER_SRC), ...readSrcFiles(ADMIN_SRC)];
    const offenders: Array<{ path: string; reason: string }> = [];
    for (const { path, src } of files) {
      // Allowlist: scaffold-data.ts owns the prose surface. (It lives in
      // @memex/shared; we still scan it implicitly if a build/dist copy
      // shows up — but readSrcFiles is scoped to server+admin only, so the
      // shared module is never walked here.)
      if (path === SHARED_SCAFFOLD_DATA) continue;

      const rel = relative(REPO_ROOT, path);
      if (ALLOWLISTED_PROSE_FILES.has(rel)) continue;

      const blocks = extractMarkdownTemplateLiterals(src);
      if (blocks.length > 0) {
        offenders.push({
          path,
          reason: `${blocks.length} multi-line markdown template literal(s)`,
        });
        continue;
      }
      if (fileContainsConcatProse(src)) {
        offenders.push({
          path,
          reason: `string-concat prose ('## heading' + ... or '- bullet' + ...)`,
        });
      }
    }
    expect(
      offenders,
      offenders.length
        ? `Prompt prose detected outside packages/shared/src/scaffold-data.ts:\n  - ${offenders
            .map((o) => `${relative(REPO_ROOT, o.path)}: ${o.reason}`)
            .join(
              "\n  - ",
            )}\nMove the prose into a PromptBlockNode / GuidanceBlock record in scaffold-data.ts.`
        : "",
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (b) Every (tool, phase) resolves to a nudge.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 drift-guard: toNudge coverage (ac-20 (b))", () => {
  it("every (tool × phase) pair returns a string from toNudge without throwing", () => {
    tagAc(AC_20);
    const failures: string[] = [];
    for (const tool of BASE_SCAFFOLD.tools) {
      for (const phase of BASE_SCAFFOLD.phases) {
        try {
          const out = toNudge({
            dataset: BASE_SCAFFOLD,
            tool: tool.name,
            phase: phase.phase,
          });
          if (typeof out !== "string") {
            failures.push(
              `(tool=${tool.name}, phase=${phase.phase}) → typeof ${typeof out} (expected string)`,
            );
          }
        } catch (err) {
          failures.push(
            `(tool=${tool.name}, phase=${phase.phase}) threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    expect(
      failures,
      failures.length
        ? `toNudge failed for one or more (tool × phase) pairs:\n  - ${failures.join("\n  - ")}`
        : "",
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (c) Every phase has required react_only prompt blocks.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 drift-guard: phase prompt-block composition (ac-20 (c))", () => {
  it("every PhaseNode declares ≥1 promptBlockId and every id resolves to a react_only PromptBlockNode", () => {
    tagAc(AC_20);
    const byId = new Map<string, PromptBlockNode>(
      BASE_SCAFFOLD.promptBlocks.map((b) => [b.id, b]),
    );
    const failures: string[] = [];
    for (const phase of BASE_SCAFFOLD.phases) {
      if (phase.promptBlockIds.length === 0) {
        failures.push(
          `PhaseNode(phase=${phase.phase}) has empty promptBlockIds — phases must declare at least one prompt block.`,
        );
        continue;
      }
      for (const id of phase.promptBlockIds) {
        const block = byId.get(id);
        if (!block) {
          failures.push(
            `PhaseNode(phase=${phase.phase}) references promptBlock id='${id}' which is not present in BASE_SCAFFOLD.promptBlocks.`,
          );
          continue;
        }
        if (block.surface !== "react_only") {
          failures.push(
            `PhaseNode(phase=${phase.phase}) references promptBlock id='${id}' whose surface='${block.surface}'. promptBlockIds must reference react_only blocks (shared_nudge blocks ride the nudge channel).`,
          );
        }
      }
    }
    expect(
      failures,
      failures.length
        ? `Phase prompt-block composition is broken:\n  - ${failures.join("\n  - ")}`
        : "",
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (d) Every base node has a non-empty rationale.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 drift-guard: rationale present on every base node (ac-20 (d))", () => {
  it("every PhaseNode / PromptBlockNode / ToolNode / TransitionRubric / source:'base' GuidanceBlock carries a non-empty rationale", () => {
    tagAc(AC_20);
    const failures: string[] = [];
    const check = (
      label: string,
      rationale: unknown,
      identifier: string,
    ): void => {
      if (typeof rationale !== "string" || rationale.trim().length === 0) {
        failures.push(
          `${label}(${identifier}) has empty/missing rationale — every base node must carry an Inspect-visible 'why this exists' string.`,
        );
      }
    };

    for (const phase of BASE_SCAFFOLD.phases as readonly PhaseNode[]) {
      check("PhaseNode", phase.rationale, `phase=${phase.phase}`);
    }
    for (const block of BASE_SCAFFOLD.promptBlocks as readonly PromptBlockNode[]) {
      check("PromptBlockNode", block.rationale, `id=${block.id}`);
    }
    for (const tool of BASE_SCAFFOLD.tools as readonly ToolNode[]) {
      check("ToolNode", tool.rationale, `name=${tool.name}`);
    }
    for (const rubric of BASE_SCAFFOLD.transitions as readonly TransitionRubric[]) {
      check("TransitionRubric", rubric.rationale, `transition=${rubric.transition}`);
    }
    for (const g of BASE_SCAFFOLD.baseGuidance as readonly GuidanceBlock[]) {
      // dec-2 contract: every base GuidanceBlock is `source: 'base'`.
      if (g.source !== "base") {
        failures.push(
          `BASE_SCAFFOLD.baseGuidance contains a row with source='${g.source}' — base guidance must be source:'base' (dec-2).`,
        );
      }
      const id = `target=${JSON.stringify(g.target)} order=${g.order}`;
      check("BaseGuidanceBlock", g.rationale, id);
    }
    expect(
      failures,
      failures.length
        ? `Rationale gaps detected:\n  - ${failures.join("\n  - ")}`
        : "",
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (e) No source:'base' row is reachable via the Org write path.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 drift-guard: Org write path cannot land source:'base' (ac-20 (e))", () => {
  it("orgScaffoldAdditions Drizzle schema has no `source` column (the table IS the discriminator — dec-3)", () => {
    tagAc(AC_20);
    // Drizzle's pg-core table exposes columns via the SQL-symbol map plus a
    // `.<name>` accessor for each defined column. We inspect both surfaces
    // and assert `source` is absent from each.
    const t = orgScaffoldAdditions as unknown as Record<string, unknown>;
    expect(
      "source" in t,
      "orgScaffoldAdditions table must not expose a `source` accessor — dec-3 says the table itself is the discriminator.",
    ).toBe(false);

    // Defensive: also walk the column metadata Drizzle stamps on the table
    // (`._.columns` on the symbol surface). If a future Drizzle version
    // changes the shape, the accessor check above still pins the invariant.
    const internal = (orgScaffoldAdditions as unknown as { _?: { columns?: Record<string, unknown> } })._;
    if (internal?.columns) {
      expect(
        Object.keys(internal.columns).includes("source"),
        "orgScaffoldAdditions._.columns must not include `source`.",
      ).toBe(false);
    }
  });

  it("CreateOrgScaffoldAdditionInput does not accept a `source` field — type-level guard via service-layer read", () => {
    tagAc(AC_20);
    // Type-level assertions in vitest run at compile time only — we
    // complement them with a runtime source-text guard. The service file
    // is the canonical author of the type; if a future change adds
    // `source` to the input shape, the source-text check below fires the
    // moment the field name lands in the interface declaration.
    const servicePath = join(
      SERVER_SRC,
      "services",
      "scaffold-additions.ts",
    );
    const src = readFileSync(servicePath, "utf-8");
    const ifaceMatch = src.match(
      /export\s+interface\s+CreateOrgScaffoldAdditionInput\s*\{([\s\S]*?)\n\}/,
    );
    expect(
      ifaceMatch,
      "CreateOrgScaffoldAdditionInput interface must exist in services/scaffold-additions.ts",
    ).toBeTruthy();
    if (!ifaceMatch) return;
    const body = ifaceMatch[1];
    expect(
      /\bsource\s*[?:]/.test(body),
      `CreateOrgScaffoldAdditionInput must not declare a 'source' field — dec-3: there is no schema path to land source:'base'.\nField body:\n${body}`,
    ).toBe(false);

    // Static type-shape assertion via TypeScript's `keyof` — keeps the
    // invariant tracked at the type system layer too. If `source` becomes
    // a key on the input type, this fails to compile (and so the test
    // file fails to build, which surfaces louder than a runtime miss).
    type Keys = keyof CreateOrgScaffoldAdditionInput;
    type HasSource = "source" extends Keys ? true : false;
    const hasSource: HasSource = false;
    expect(hasSource).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// b-67 cross-check: the manifest ↔ Zod parity regression test still exists.
// ──────────────────────────────────────────────────────────────────────────

describe("b-68 drift-guard: b-67 manifest↔Zod parity test is still present (ac-20)", () => {
  it("packages/server/src/__regression__/tool-manifest-args.regression.test.ts exists and references manifestVsSpecsDiff", () => {
    tagAc(AC_20);
    const path = join(
      __dirname,
      "tool-manifest-args.regression.test.ts",
    );
    const src = readFileSync(path, "utf-8");
    // Three load-bearing markers: the import surface, the diff function the
    // b-67 test pins, and the per-tool parity loop.
    expect(src).toContain("import { toolManifest }");
    expect(src).toContain("manifestVsSpecsDiff");
    expect(src).toMatch(/for\s*\(\s*const\s+spec\s+of\s+toolSpecs\s*\)/);
  });
});
