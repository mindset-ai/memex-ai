// NOT IN USE — paired with doc-24 (codebase intelligence tools commented out in tool-specs.ts). Restore alongside the tools.
// Markdown formatters for codebase-intelligence MCP tool responses.
// Kept in a separate file from formatters.ts so merge conflicts with Barrie's
// ongoing document/decision/task work stay minimal.

import type {
  Repo,
  RepoDomain,
  RepoStructure,
  RepoTechStack,
  File,
  Symbol,
  Dependency,
  Call,
} from "../db/schema.js";
import type { RepoOverviewCounts } from "../services/repos.js";
import type { EndpointWithFile } from "../services/endpoints.js";
import type { CallGraphRow } from "../services/calls.js";
import type { HybridHit } from "../services/code-search.js";

function truncate(text: string | null | undefined, max = 200): string {
  if (!text) return "";
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? single.slice(0, max - 1) + "…" : single;
}

// Workflow reminder appended to every read-shaped codebase response. Mirrors
// the STANDARDS_PROTOCOL_FOOTER pattern: keep the rules in front of the agent
// without bloating per-tool descriptions, and let the agent route around the
// pull-to-write reflex (read first, search standards first, flag drift when
// you see it). Skill source: packages/server/src/agent/skills/spec-workflow.md.
export const CODEBASE_LOOP_FOOTER = [
  "",
  "---",
  "",
  "**Codebase loop** — when reading code as part of `build`:",
  "- Read before write. Use `list_symbols`, `code_search`, `get_symbol(include:['dependencies'])` to ground the change before generating.",
  "- `search_memex({ query, kind: 'standard' })` for the area you're about to touch — pinned team rules live there.",
  "- If you spot a rule that's wrong or stale, `propose_standard_change(ref, proposedContent)` where `ref` is the section's canonical ref (e.g. `…/standards/std-N/sections/s-M`). If the rule is right but the code has drifted, `flag_drift(ref, observation)`. Don't route around either.",
  "- A task is `complete` only when verification actually runs (type checks + tests + the new path exercised). Plausibility is the failure mode.",
].join("\n");

function withCodebaseLoopFooter(body: string): string {
  return `${body}\n${CODEBASE_LOOP_FOOTER}`;
}

// ── get_repo (formerly get_repo_overview) ─────────────────────────────

export function formatRepoOverview(
  repo: Repo,
  counts: RepoOverviewCounts,
  techStack: RepoTechStack[],
  domains: RepoDomain[],
  structure: RepoStructure[],
): string {
  const lines: string[] = [];
  lines.push(`# Repo: ${repo.name}`);
  lines.push(`URL: ${repo.url}`);
  lines.push(`Default branch: ${repo.defaultBranch}`);
  if (repo.lastSyncedAt) {
    lines.push(`Last synced: ${repo.lastSyncedAt.toISOString()}`);
  }
  lines.push("");

  lines.push("## Counts");
  lines.push(`- Files: ${counts.files}`);
  lines.push(`- Symbols: ${counts.symbols}`);
  lines.push(`- Dependencies: ${counts.dependencies}`);
  lines.push(`- Calls: ${counts.calls}`);
  lines.push(`- HTTP endpoints: ${counts.endpoints}`);
  lines.push(`- Domains: ${counts.domains}`);
  lines.push("");

  if (techStack.length > 0) {
    lines.push("## Tech stack");
    const byLayer = new Map<string, string[]>();
    for (const t of techStack) {
      const arr = byLayer.get(t.layer) ?? [];
      const ev = t.evidence && t.evidence.length > 0 ? ` (${t.evidence.join(", ")})` : "";
      arr.push(`${t.name}${ev}`);
      byLayer.set(t.layer, arr);
    }
    for (const [layer, items] of byLayer) {
      lines.push(`- **${layer}**: ${items.join("; ")}`);
    }
    lines.push("");
  }

  if (domains.length > 0) {
    lines.push("## Domains");
    for (const d of domains) {
      const aliases = d.aliases && d.aliases.length > 0 ? ` — aliases: ${d.aliases.join(", ")}` : "";
      const paths = d.rootPaths && d.rootPaths.length > 0 ? ` [${d.rootPaths.join(", ")}]` : "";
      lines.push(`- ${d.name} (${d.fileCount ?? 0} files)${paths}${aliases}`);
      if (d.description) lines.push(`  ${d.description}`);
    }
    lines.push("");
  }

  if (structure.length > 0) {
    lines.push("## Structural conventions");
    for (const s of structure) {
      lines.push(`- ${s.kind}: \`${s.pathPattern}\` (${s.fileCount ?? 0} files)`);
    }
    lines.push("");
  }

  lines.push("## Next steps");
  lines.push("- Call `list_symbols` to locate specific functions/classes by name.");
  lines.push("- Call `list_symbols(kind: 'endpoint')` to see HTTP routes.");
  lines.push("- Call `code_search` for hybrid semantic + lexical search when you're looking by intent rather than an exact symbol name.");
  lines.push("- Scope queries by passing a domain alias when supported.");

  return withCodebaseLoopFooter(lines.join("\n").trimEnd());
}

// ── list_symbols (formerly find_symbol) ───────────────────────────────────

export function formatSymbolList(rows: Array<Symbol & { filePath: string }>): string {
  if (rows.length === 0) {
    return withCodebaseLoopFooter(
      "No symbols matched. Try a shorter / partial query, drop the `kind` filter, or fall back to `code_search` for intent-shaped queries.",
    );
  }
  const lines: string[] = [];
  lines.push(`Found ${rows.length} symbol${rows.length === 1 ? "" : "s"}:`);
  lines.push("");
  for (const s of rows) {
    const parent = s.parentName ? `${s.parentName}.` : "";
    const exported = s.isExported ? " (exported)" : "";
    const asyncFlag = s.isAsync ? " (async)" : "";
    lines.push(`- **${parent}${s.name}** [${s.kind}]${exported}${asyncFlag}`);
    lines.push(`  \`${s.filePath}\`:${s.lineStart ?? "?"}-${s.lineEnd ?? "?"}  ID: ${s.id}`);
    if (s.signature) lines.push(`  \`${truncate(s.signature, 160)}\``);
    if (s.docComment) lines.push(`  > ${truncate(s.docComment, 200)}`);
  }
  return withCodebaseLoopFooter(lines.join("\n"));
}

// ── list_symbols(kind:"endpoint") (formerly get_endpoints) ─────────────────────────────────

export function formatEndpointList(rows: EndpointWithFile[]): string {
  if (rows.length === 0) {
    return withCodebaseLoopFooter("No HTTP endpoints found.");
  }
  const lines: string[] = [];
  lines.push(`Found ${rows.length} endpoint${rows.length === 1 ? "" : "s"}:`);
  lines.push("");
  for (const ep of rows) {
    const framework = ep.framework ? ` [${ep.framework}]` : "";
    lines.push(`- **${ep.method}** \`${ep.path}\`${framework}`);
    lines.push(`  → ${ep.handlerName ?? "?"} @ \`${ep.filePath}\`:${ep.lineNumber ?? "?"}`);
    if (ep.handlerSignature) lines.push(`  \`${truncate(ep.handlerSignature, 160)}\``);
  }
  return withCodebaseLoopFooter(lines.join("\n"));
}

// ── get_symbol(include:["dependencies"]) ──────────────────────────────

type DepRow = Dependency & { fromPath: string | null; toPath: string | null };

export function formatDependencyList(
  rows: DepRow[],
  direction: "imports" | "importers" | "both",
  subjectPath: string,
): string {
  if (rows.length === 0) {
    return withCodebaseLoopFooter(`No ${direction} found for \`${subjectPath}\`.`);
  }
  const lines: string[] = [];
  lines.push(`# Dependencies for \`${subjectPath}\` (${direction})`);
  lines.push("");

  const imports = rows.filter((r) => r.fromPath === subjectPath);
  const importers = rows.filter((r) => r.toPath === subjectPath);

  if (direction !== "importers" && imports.length > 0) {
    lines.push(`## What this file imports (${imports.length})`);
    for (const d of imports) {
      const target = d.toPath ?? d.toPackage ?? "?";
      const kind = d.kind === "internal" ? "" : " [external]";
      const syms = d.importedSymbols && d.importedSymbols.length > 0 ? ` {${d.importedSymbols.join(", ")}}` : "";
      lines.push(`- ${target}${kind}${syms}`);
    }
    lines.push("");
  }

  if (direction !== "imports" && importers.length > 0) {
    lines.push(`## Files that import this (${importers.length})`);
    for (const d of importers) {
      const syms = d.importedSymbols && d.importedSymbols.length > 0 ? ` {${d.importedSymbols.join(", ")}}` : "";
      lines.push(`- ${d.fromPath ?? "?"}${syms}`);
    }
  }

  return withCodebaseLoopFooter(lines.join("\n").trimEnd());
}

// ── get_symbol(include:["impact"]) ────────────────────────────────────

export function formatImpact(
  subject: string,
  depth: number,
  rows: Array<{ fileId: string; path: string; distance: number }>,
): string {
  if (rows.length === 0) {
    return withCodebaseLoopFooter(
      `No files depend on \`${subject}\` (within depth ${depth}).`,
    );
  }
  const lines: string[] = [];
  lines.push(`# Impact of \`${subject}\` (depth ${depth})`);
  lines.push(`${rows.length} file${rows.length === 1 ? "" : "s"} would be affected.`);
  lines.push("");

  const byDistance = new Map<number, string[]>();
  for (const r of rows) {
    const arr = byDistance.get(r.distance) ?? [];
    arr.push(r.path);
    byDistance.set(r.distance, arr);
  }
  const distances = [...byDistance.keys()].sort((a, b) => a - b);
  for (const d of distances) {
    const paths = byDistance.get(d)!;
    lines.push(`## Distance ${d} (${paths.length})`);
    for (const p of paths) lines.push(`- ${p}`);
    lines.push("");
  }
  return withCodebaseLoopFooter(lines.join("\n").trimEnd());
}

// ── get_symbol(include:["calls"]) ────────────────────────────────

export function formatCallGraph(
  subject: string,
  direction: "callers" | "callees" | "both",
  callers: CallGraphRow[],
  callees: CallGraphRow[],
): string {
  const lines: string[] = [];
  lines.push(`# Call graph for \`${subject}\` (${direction})`);
  lines.push("");

  if (direction !== "callees") {
    lines.push(`## Callers (${callers.length})`);
    if (callers.length === 0) {
      lines.push("_None._");
    } else {
      for (const c of callers) {
        lines.push(`- **${c.fromSymbolName}** @ \`${c.fromPath}\`:${c.lineNumber ?? "?"}${c.resolutionKind ? ` [${c.resolutionKind}]` : ""}`);
      }
    }
    lines.push("");
  }

  if (direction !== "callers") {
    lines.push(`## Callees (${callees.length})`);
    if (callees.length === 0) {
      lines.push("_None._");
    } else {
      for (const c of callees) {
        const target = c.toSymbolName ? `**${c.toSymbolName}** @ \`${c.toPath}\`` : `unresolved → \`${c.toName}\``;
        const kind = c.resolutionKind ? ` [${c.resolutionKind}]` : "";
        const noise = c.isNoise ? " (noise)" : "";
        lines.push(`- ${target}:${c.lineNumber ?? "?"}${kind}${noise}`);
      }
    }
  }

  return withCodebaseLoopFooter(lines.join("\n").trimEnd());
}

// ── code_search (hybrid: semantic symbol + lexical file, fused via RRF) ──

export function formatCodeSearchResults(
  phrases: string[],
  keywords: string[] | null,
  hits: HybridHit[],
  warnings: string[],
): string {
  const lines: string[] = [];
  lines.push(`# Code search`);
  if (phrases.length === 1) {
    lines.push(`Phrase: \`${phrases[0]}\``);
  } else {
    lines.push(`Phrases (${phrases.length}, each ranked independently then RRF-merged):`);
    for (const p of phrases) lines.push(`  - \`${p}\``);
  }
  if (keywords && keywords.length > 0) {
    lines.push(`Keywords: ${keywords.map((k) => `\`${k}\``).join(", ")}`);
  }
  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) lines.push(`> ⚠ ${w}`);
  }
  lines.push("");
  if (hits.length === 0) {
    lines.push("No matches.");
    lines.push("");
    lines.push(
      "Try different `phrases` at different abstraction levels — one conceptual, one code-native (e.g. ['preventing the agent from answering without grounding', 'KnowledgeLimits policy enforcement']). Add 2-5 specific `keywords` likely to appear literally in code. Fall back to `list_symbols` for exact identifiers.",
    );
    lines.push(
      "If the codebase genuinely doesn't answer this, post a `question`-typed comment via `add_comment(...)` rather than guessing — don't grind for an hour producing plausible code.",
    );
    return withCodebaseLoopFooter(lines.join("\n").trimEnd());
  }
  lines.push(`${hits.length} result${hits.length === 1 ? "" : "s"} (ranked by combined evidence, RRF-merged).`);
  lines.push("");
  for (const h of hits) {
    const badge = h.source === "both" ? "🟢 both" : h.source === "semantic" ? "🔵 semantic" : "🟡 lexical";
    const loc =
      h.symbolName && h.lineStart
        ? `\`${h.filePath}\`:${h.lineStart}-${h.lineEnd ?? "?"} · **${h.symbolName}** [${h.symbolKind ?? "symbol"}]`
        : `\`${h.filePath}\` (file-level)`;
    const agree = h.matchedRankers > 1 ? ` · matched ${h.matchedRankers}×` : "";
    lines.push(`- ${badge} · ${loc}${agree}`);
    const scores: string[] = [];
    if (h.semanticScore !== null) scores.push(`sem ${h.semanticScore.toFixed(3)}`);
    if (h.lexicalScore !== null) scores.push(`lex ${h.lexicalScore.toFixed(3)}`);
    scores.push(`rrf ${h.rrfScore.toFixed(4)}`);
    lines.push(`  ${scores.join(" · ")}`);
    if (h.snippet) {
      const snippet = h.snippet.split("\n").slice(0, 3).join("\n").slice(0, 300);
      lines.push("  > " + snippet.replace(/\n/g, "\n  > "));
    }
  }
  lines.push("");
  lines.push("Follow up with `get_file` on interesting files, or `get_symbol(include:['calls'])` / `list_symbols` on named symbols.");
  return withCodebaseLoopFooter(lines.join("\n").trimEnd());
}

// ── get_file (formerly get_file_content) ──────────────────────────────

export function formatFileContent(file: File): string {
  const lines: string[] = [];
  lines.push(`# \`${file.path}\``);
  const meta = [
    file.language ? `${file.language}` : null,
    file.sizeBytes !== null ? `${file.sizeBytes} bytes` : null,
    file.isTest ? "test file" : null,
  ].filter(Boolean);
  lines.push(meta.join(" · "));
  lines.push("");
  lines.push("```" + (file.language ?? ""));
  lines.push(file.content ?? "");
  lines.push("```");
  return withCodebaseLoopFooter(lines.join("\n").trimEnd());
}

// ── update_repo / admin ack ───────────

export function formatAdminAck(message: string): string {
  return `✓ ${message}`;
}
