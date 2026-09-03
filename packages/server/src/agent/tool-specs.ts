// spec-366 (sol-1 of audit spec-345, umbrella spec-354): the tool CATALOGUE.
//
// b-67 t-2 [per std-19]: the canonical tool list + presentation metadata live
// in `@memex/shared`'s `toolManifest` (the std-16 source of truth). This file is
// the runtime half: it composes the per-domain ToolSpec arrays from
// `./handlers/*` (schema + handler + MCP annotations + rich descriptions) into
// the single `toolSpecs` catalogue both surfaces (MCP `mcp/tools.ts` + the React
// agent `agent/tools.ts`) wrap. The shared handler infrastructure (ToolCtx,
// helpers, the guidance envelope) lives in `./handlers/tool-contract.ts` and
// its siblings (std-12); spec-546 named them for their contents.
//
// `list_memexes` is the one tool registered inline in `mcp/tools.ts` (not here),
// so `manifestVsSpecsDiff` (below) excludes it from the manifest cross-check.
//
// Adding/changing a tool: edit the relevant `./handlers/<domain>.ts` module
// (both surfaces inherit it) and the manifest in `packages/shared/src/
// tool-manifest.ts`; the b-67 regression test asserts the two stay in lockstep.

import { toolManifest } from "@memex/shared";
import type {
  ToolSpec,
} from "./handlers/tool-contract.js";

// spec-366: re-export the shared infra symbols external modules/tests import
// from this file, so no import site moved (std-16 contract unchanged).
//
// spec-546 dec-2: this façade STAYS, permanently. It is not a compatibility
// shim — it is the actual interface. Dozens of files import from here, and for
// five of the symbols below it is the ONLY route out of handlers/:
// composeGuidanceEnvelope, renderFooterSignal, craftActivityBlock,
// composeStatusOverview, StatusFacts.
//
// Do NOT "fix" those five by moving them here under std-51's single-consumer
// rule. Their DEFINITIONS staying in agent/handlers/ is what keeps
// guidance-authoring-confined.regression.test.ts able to see them; republishing
// a symbol from here is fine, relocating its definition is not.
//
// spec-548 narrowed the reason, and removed two names from this block.
// dec-1: that guard's per-builder loop was `let idx = SRC.indexOf(call); while
// (idx !== -1) { … }`, so a call token that left the scanned directory made the
// body never run and the test passed while asserting NOTHING — in green. It now
// asserts each token is PRESENT before scanning, and floors the list length, so
// a vanished builder reds and names itself. dec-3: the guard's corpus is now
// agent/handlers/*.ts PLUS this file, so prose authored in the façade is an
// offender rather than invisible — which is why the completion nudge and the
// related-issues nudge are no longer re-exported here. Their only consumers were
// four tests, now importing from the handler modules directly (std-51: an
// export exists for a production caller or it does not exist). A guard that
// forbids USING the prose outside renderFooterSignal while this file
// DISTRIBUTED it was contradicting itself.
//
// Named in prose, not spelled, deliberately: the guard scans raw TEXT, so a
// comment carrying a builder's token is flagged like a use. (Only tokens with
// no trailing paren are comment-sensitive this way.) The alternative — teaching
// the guard to skip comment lines — widens what it tolerates to fix a comment,
// and dec-3 already declined the same shape of concession for re-export lines.
export {
  buildNudgeOrgBlocksGetter,
  // spec-366: re-exported because tool-specs.audit.integration.test.ts imports
  // VERBOSE_FIELD from here to assert the shared-instance identity contract.
  VERBOSE_FIELD,
  MEMEX_DESC,
} from "./handlers/tool-contract.js";
export {
  composeGuidanceEnvelope,
  craftActivityBlock,
  composeStatusOverview,
  formatAcCoverageSummary,
} from "./handlers/guidance-envelope.js";
export {
  relatedIssuesForDecision,
  suggestActiveSpecsForIssue,
} from "./handlers/related-issues.js";
export type {
  StatusFacts,
} from "./handlers/guidance-envelope.js";
export type {
  ToolCtx,
  ToolSpec,
  ResolvedRef,
  EntityKind,
  FooterSlot,
} from "./handlers/tool-contract.js";


// spec-366: the per-domain handler modules. tool-specs.ts composes their
// ToolSpec arrays into the single `toolSpecs` catalogue (std-12).
import {
  docsTools,
  tagsTools,
  sectionsTools,
  decisionsTools,
  acsTools,
  tasksTools,
  commentsTools,
  lifecycleTools,
  issuesTools,
  rolesTools,
  checkoutTools,
  standardsTools,
  facetsTools,
  integrationsTools,
  skillsTools,
} from "./handlers/index.js";
// spec-360: the scaffold-assistant authoring tool (propose_scaffold_change).
// Lives in its own handler module like the other domains, but is AGENT-ONLY
// (never on MCP) — see AGENT_ONLY_SERVER_TOOLS below.
import { scaffoldTools } from "./handlers/scaffold.js";

// spec-360 t-3: server tools that live ONLY on the in-app agent surface, never
// on MCP. `propose_scaffold_change` is the scaffold assistant's propose-then-
// confirm authoring tool — it only makes sense inside the `scaffold` agent mode
// (it needs the composed scaffold grounding context), so it is excluded from the
// MCP catalogue and from the manifest the way `list_memexes` is MCP-only. This
// is the single source the MCP registration loop (`mcp/tools.ts`) and the
// manifest parity check (`manifestVsSpecsDiff`) both consult.
export const AGENT_ONLY_SERVER_TOOLS: ReadonlySet<string> = new Set([
  "propose_scaffold_change",
  // spec-416 dec-1: the standards agent's dedicated standard-creation verb.
  // Like propose_scaffold_change, it only makes sense inside an in-app agent
  // mode (the `standards` mode), so it is NOT registered on MCP and is
  // intentionally absent from the @memex/shared manifest — excluded from the
  // b-67 manifest↔MCP parity cross-check the same way. (MCP coding agents
  // already mint standards via create_doc({docType:'standard'}); the scope wall
  // this tool enforces is specifically about the constrained in-app standards
  // agent.)
  "create_standard",
]);

export const toolSpecs: ToolSpec[] = [
  ...docsTools,
  // spec-418 t-4: tag-catalogue curation (create_tag / rename_tag / delete_tag) —
  // thin wrappers over the same services/tags.ts curation functions REST calls.
  ...tagsTools,
  ...sectionsTools,
  ...decisionsTools,
  ...acsTools,
  ...tasksTools,
  ...commentsTools,
  ...lifecycleTools,
  ...issuesTools,
  ...rolesTools,
  ...checkoutTools,
  ...standardsTools,
  ...facetsTools,

  // ── Codebase intelligence ─────────────────────────────────
  // TEMPORARILY DISABLED — codebase tools are commented out (both MCP + React UI agent).
  // To restore: delete the `/*` below and the matching `*/` before the closing `];` of toolSpecs.
  /*
  {
    name: "list_repos",
    annotations: { title: "List repos", readOnlyHint: true, destructiveHint: false },
    description:
      "List all repos ingested into a Memex with name, url, default branch, last-synced timestamp. Call first to discover what's available.",
    schema: { memex: z.string().optional().describe(MEMEX_DESC), verbose: VERBOSE_FIELD },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const memexId = await ctx.resolveMemex(memex);
      const rows = await listRepos(memexId);

      if (ctx.verbose) {
        if (rows.length === 0) return "No repos ingested into this Memex yet.";
        const lines = rows.map((r) => {
          const synced = r.lastSyncedAt
            ? new Date(r.lastSyncedAt).toISOString().slice(0, 10)
            : "never";
          return `- ${r.name} (${r.url}) — branch ${r.defaultBranch ?? "main"}, last synced ${synced}`;
        });
        return `Repos in this Memex:\n${lines.join("\n")}`;
      }

      if (rows.length === 0) return "No repos ingested into this Memex yet.";
      return (
        "Repos:\n" +
        rows
          .map(
            (r) =>
              `- ${r.name} (uuid: ${r.id}) (${r.url}) — branch ${r.defaultBranch ?? "main"}, last synced ${r.lastSyncedAt ? new Date(r.lastSyncedAt).toISOString().slice(0, 10) : "never"}`,
          )
          .join("\n")
      );
    },
  },
  {
    name: "get_repo",
    annotations: { title: "Get repo", readOnlyHint: true, destructiveHint: false },
    description:
      "Orient on a repo: file/symbol/endpoint/domain counts, tech stack, detected domains, structural conventions. Replaces get_repo_overview. Always call this first before drilling into a codebase.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const [counts, techStack, domains, structure] = await Promise.all([
        getRepoOverviewCounts(repo.id),
        listTechStack(repo.id),
        listDomains(repo.id),
        listStructure(repo.id),
      ]);

      if (ctx.verbose) {
        return formatRepoOverview(repo, counts, techStack, domains, structure);
      }
      const lines: string[] = [];
      lines.push(
        `${repo.name} (uuid: ${repo.id}): ${counts.files} files, ${counts.symbols} symbols, ${counts.endpoints} endpoints, ${counts.domains} domains`,
      );
      if (techStack.length > 0)
        lines.push(`Tech: ${techStack.map((t) => `${t.layer}=${t.name}`).join(", ")}`);
      if (domains.length > 0)
        lines.push(
          `Domains: ${domains.map((d) => `${d.name} (${d.fileCount} files)`).join(", ")}`,
        );
      if (structure.length > 0)
        lines.push(
          `Conventions: ${structure.map((s) => `${s.kind}=${s.pathPattern}`).join(", ")}`,
        );
      return lines.join("\n");
    },
  },
  {
    name: "update_repo",
    annotations: { title: "Update repo", readOnlyHint: false, destructiveHint: false },
    description:
      "Update a repo's metadata. Today: `domainAliases` attaches business names to an auto-detected domain so future queries can scope by natural language. Replaces set_repo_domain_aliases.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      domainAliases: z
        .object({
          domainName: z.string().describe("The detected domain name (from get_repo)."),
          aliases: z.array(z.string()).describe("Business names the team uses."),
          description: z.string().optional(),
        })
        .optional()
        .describe("Attach business names to a detected domain so future queries can scope by natural language."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const aliases = input.domainAliases as
        | { domainName: string; aliases: string[]; description?: string }
        | undefined;

      if (!aliases) {
        throw new ValidationError(
          "update_repo currently requires `domainAliases`. Other fields TBD.",
        );
      }
      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      await setDomainAliases(repo.id, aliases.domainName, aliases.aliases, aliases.description ?? null);

      if (ctx.verbose) {
        return formatAdminAck(
          `Set aliases on domain \`${aliases.domainName}\`: ${aliases.aliases.join(", ")}`,
        );
      }
      return `Set aliases on domain '${aliases.domainName}': ${aliases.aliases.join(", ")}`;
    },
  },
  {
    name: "list_symbols",
    annotations: { title: "List symbols", readOnlyHint: true, destructiveHint: false },
    description:
      "List symbols in a repo. Filter by `query` (case-insensitive partial name match), `kind` (function/class/method/interface/type/enum/constant/field/endpoint), `domain` (alias scopes by path), `framework` (for endpoints), `exportedOnly`. " +
      "When `kind='endpoint'`, returns HTTP route registrations with handlers and signatures (replaces get_endpoints). " +
      "Replaces find_symbol, get_endpoints.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      query: z
        .string()
        .optional()
        .describe("Partial symbol name, case-insensitive. Optional for kind='endpoint'."),
      kind: z
        .string()
        .optional()
        .describe("function/class/method/interface/type/enum/constant/field/endpoint"),
      domain: z.string().optional().describe("Domain alias to scope by — restricts the search to files inside that domain's path."),
      framework: z.string().optional().describe("Only meaningful for kind='endpoint'."),
      exportedOnly: z.boolean().optional().describe("If true, exclude non-exported symbols."),
      limit: z.number().optional().describe("Cap on the number of rows returned."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const query = input.query as string | undefined;
      const kind = input.kind as string | undefined;
      const domain = input.domain as string | undefined;
      const framework = input.framework as string | undefined;
      const exportedOnly = input.exportedOnly as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const pathLike = await pathLikeForDomain(repo.id, domain);

      if (kind === "endpoint") {
        const rows = await listEndpoints(repo.id, { pathLike, framework });
        if (ctx.verbose) return formatEndpointList(rows);
        if (rows.length === 0) return "No endpoints detected.";
        return rows
          .map(
            (r) =>
              `- ${r.method} ${r.path} → ${r.handlerName ?? "?"} @ ${r.filePath}:${r.lineNumber ?? "?"} (uuid: ${r.id})`,
          )
          .join("\n");
      }

      if (!query) {
        throw new ValidationError("list_symbols requires `query` (unless kind='endpoint').");
      }
      const rows = await findSymbols(repo.id, query, { kind, pathLike, exportedOnly, limit });

      if (ctx.verbose) return formatSymbolList(rows);
      if (rows.length === 0) return `No symbols matched '${query}'.`;
      return rows
        .map(
          (r) =>
            `- ${r.name} [${r.kind}] @ ${r.filePath}:${r.lineStart ?? "?"}-${r.lineEnd ?? "?"} (uuid: ${r.id})`,
        )
        .join("\n");
    },
  },
  {
    name: "get_symbol",
    annotations: { title: "Get symbol", readOnlyHint: true, destructiveHint: false },
    description:
      "Inspect a symbol or file with optional include flags. Replaces get_dependencies, get_impact, get_call_graph.\n" +
      "Pass either:\n" +
      "  - `symbolId`: a symbol UUID (from list_symbols). Combine with `include: ['calls']` for the call graph.\n" +
      "  - `fileId` or `path`: a file. Combine with `include: ['dependencies']` (import graph) and/or `['impact']` (importer-graph blast radius).\n" +
      "Other args: `direction` (callers/callees/both for calls; imports/importers/both for dependencies), `depth` (impact recursion, default 3), `includeNoise` (calls only), `limit`.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      symbolId: z.string().optional().describe("Symbol UUID (from list_symbols)."),
      fileId: z.string().optional().describe("File UUID. Use with `include: ['dependencies']` or `['impact']`."),
      path: z.string().optional().describe("Partial file path."),
      include: z
        .array(z.enum(["dependencies", "impact", "calls"]))
        .optional()
        .describe("Which views to include in the response."),
      direction: z
        .string()
        .optional()
        .describe(
          "'imports'|'importers'|'both' for dependencies; 'callers'|'callees'|'both' for calls.",
        ),
      depth: z.number().optional().describe("Recursion depth for impact (default 3)."),
      includeNoise: z.boolean().optional().describe("Calls only — include framework / standard-library noise in the call graph."),
      limit: z.number().optional().describe("Cap on the number of rows returned."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const symbolId = input.symbolId as string | undefined;
      const fileId = input.fileId as string | undefined;
      const filePath = input.path as string | undefined;
      const include = input.include as string[] | undefined;
      const direction = input.direction as string | undefined;
      const depth = input.depth as number | undefined;
      const includeNoise = input.includeNoise as boolean | undefined;
      const limit = input.limit as number | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const wants = new Set(include ?? []);

      if (wants.size === 0) {
        throw new ValidationError(
          "get_symbol requires `include` with at least one of: 'dependencies' (file), 'impact' (file), 'calls' (symbol).",
        );
      }

      const sections: string[] = [];

      // File-scoped operations
      if (wants.has("dependencies") || wants.has("impact")) {
        if (!fileId && !filePath) {
          throw new ValidationError("dependencies/impact require fileId or path.");
        }
        let resolvedId = fileId;
        let resolvedPath = filePath ?? "";
        if (!resolvedId && filePath) {
          const f = await getFileByPath(repo.id, filePath);
          if (!f) throw new ValidationError(`No file matches path '${filePath}'`);
          resolvedId = f.id;
          resolvedPath = f.path;
        } else if (resolvedId) {
          const f = await getFileById(repo.id, resolvedId);
          if (!f) throw new ValidationError(`No file with id ${resolvedId} in this repo`);
          resolvedPath = f.path;
        }

        if (wants.has("dependencies")) {
          const dir = (direction as "imports" | "importers" | "both" | undefined) ?? "both";
          const rows = await getImportsForFile(repo.id, resolvedId!, dir);
          if (ctx.verbose) {
            sections.push(formatDependencyList(rows, dir, resolvedPath));
          } else if (rows.length === 0) {
            sections.push(`Dependencies (${dir}) for ${resolvedPath}: none.`);
          } else {
            const lines = rows.map((r) => {
              const other = r.toFileId ? r.toPath : r.toPackage;
              const names =
                r.importedSymbols && r.importedSymbols.length > 0
                  ? ` {${r.importedSymbols.join(", ")}}`
                  : "";
              return `- ${r.kind}: ${other ?? "?"}${names}`;
            });
            sections.push(`Dependencies (${dir}) for ${resolvedPath}:\n${lines.join("\n")}`);
          }
        }
        if (wants.has("impact")) {
          const d = depth ?? 3;
          const rows = await getFileImpact(repo.id, resolvedId!, d);
          if (ctx.verbose) {
            sections.push(formatImpact(resolvedPath, d, rows));
          } else if (rows.length === 0) {
            sections.push(`${resolvedPath}: 0 files affected at depth ${d}.`);
          } else {
            sections.push(
              `${resolvedPath}: ${rows.length} files affected at depth ${d}.\n` +
                rows.map((r) => `- d${r.distance}: ${r.path}`).join("\n"),
            );
          }
        }
      }

      // Symbol-scoped operations
      if (wants.has("calls")) {
        if (!symbolId) throw new ValidationError("calls requires symbolId.");
        const dir = (direction as "callers" | "callees" | "both" | undefined) ?? "both";
        const opts = { includeNoise, limit };
        const [callers, callees] = await Promise.all([
          dir === "callees" ? Promise.resolve([]) : getCallersOf(repo.id, symbolId, opts),
          dir === "callers" ? Promise.resolve([]) : getCalleesOf(repo.id, symbolId, opts),
        ]);
        if (ctx.verbose) {
          sections.push(formatCallGraph(symbolId, dir, callers, callees));
        } else {
          const lines: string[] = [];
          if (callers.length > 0) {
            lines.push(`Callers (${callers.length}):`);
            lines.push(
              ...callers.map(
                (c) =>
                  `- ${c.fromSymbolName} @ ${c.fromPath}:${c.lineNumber ?? "?"} [${c.resolutionKind ?? "?"}]`,
              ),
            );
          }
          if (callees.length > 0) {
            lines.push(`Callees (${callees.length}):`);
            lines.push(
              ...callees.map(
                (c) =>
                  `- ${c.toSymbolName ?? c.toName} @ ${c.toPath ?? "external"}:${c.lineNumber ?? "?"} [${c.resolutionKind ?? "?"}]`,
              ),
            );
          }
          sections.push(lines.length > 0 ? lines.join("\n") : "No calls.");
        }
      }

      return sections.join("\n\n");
    },
  },
  {
    name: "get_file",
    annotations: { title: "Get file content", readOnlyHint: true, destructiveHint: false },
    description:
      "Read the full source of a file. Provide fileId or partial path. Replaces get_file_content.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      fileId: z.string().optional().describe("File UUID. Provide either fileId or path."),
      path: z.string().optional().describe("Partial file path. Provide either fileId or path."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const fileId = input.fileId as string | undefined;
      const filePath = input.path as string | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      if (!fileId && !filePath) {
        throw new ValidationError("Provide either fileId or path");
      }
      const file = fileId
        ? await getFileById(repo.id, fileId)
        : await getFileByPath(repo.id, filePath!);
      if (!file) throw new NotFoundError("No file found in this repo");

      if (ctx.verbose) return formatFileContent(file);
      return `${file.path}:\n\n${file.content ?? ""}`;
    },
  },
  {
    name: "code_search",
    annotations: { title: "Code search", readOnlyHint: true, destructiveHint: false },
    description:
      "Hybrid code search: semantic (meaning) + lexical (keywords), merged via reciprocal rank fusion. " +
      "STRONGLY prefer `phrases` (array, two phrasings at different abstraction levels) over `phrase`. Each phrase becomes an independent ranker; RRF fuses them. " +
      "Also pass `keywords` (2-5 specific identifiers) to drive the lexical FTS side.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      repoRef: z.string().describe("Repo name, URL, or UUID."),
      phrase: z.string().optional().describe("Single semantic phrase. Prefer `phrases` for better recall."),
      phrases: z.array(z.string()).optional().describe("2+ phrasings at different abstraction levels — each becomes an independent ranker fused via RRF."),
      keywords: z.array(z.string()).optional().describe("2-5 specific identifiers driving the lexical FTS side."),
      limit: z.number().optional().describe("Cap on hits returned."),
      model: z.string().optional().describe("Override the embedding model (defaults to the repo's configured model)."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memex = input.memex as string | undefined;
      const repoRef = input.repoRef as string;
      const phrase = input.phrase as string | undefined;
      const phrases = input.phrases as string[] | undefined;
      const keywords = input.keywords as string[] | undefined;
      const limit = input.limit as number | undefined;
      const model = input.model as string | undefined;

      const memexId = await ctx.resolveMemex(memex);
      const repo = await resolveRepoRef(memexId, repoRef);
      const { hits, warnings } = await codeSearch(repo.id, {
        phrase,
        phrases,
        keywords,
        limit,
        model,
      });

      if (ctx.verbose) {
        const displayPhrases = [...(phrase ? [phrase] : []), ...(phrases ?? [])];
        return formatCodeSearchResults(displayPhrases, keywords ?? null, hits, warnings);
      }

      const lines: string[] = [];
      if (warnings.length > 0) lines.push(`warnings: ${warnings.join("; ")}`);
      if (hits.length === 0) {
        lines.push("No matches.");
      } else {
        for (const h of hits) {
          const loc =
            h.symbolName && h.lineStart
              ? `${h.filePath}:${h.lineStart} · ${h.symbolName} [${h.symbolKind ?? "?"}]`
              : `${h.filePath} (file)`;
          lines.push(`- [${h.source}] ${loc} (rrf ${h.rrfScore.toFixed(4)})`);
        }
      }
      return lines.join("\n");
    },
  },
  */


  ...integrationsTools,

  // ── Skills (spec-300) ─────────────────────────────────────
  // list_skills / get_skill / verb-dispatched update_skill — a thin adapter over
  // the Skills service (services/skills). std-16: mirrored in the @memex/shared
  // manifest, held in lockstep by the b-67 parity test.
  ...skillsTools,

  // ── Scaffold assistant (spec-360) ─────────────────────────
  // propose_scaffold_change — AGENT-ONLY (see AGENT_ONLY_SERVER_TOOLS): in the
  // agent surface, excluded from MCP + the manifest cross-check.
  ...scaffoldTools,
];


// ══════════════════════════════════════
// b-67 t-2: manifest ↔ specs cross-check
// ══════════════════════════════════════
//
// Returns the symmetric difference between the tool names declared in this
// file's `toolSpecs` array and the names in `@memex/shared`'s `toolManifest`,
// EXCLUDING `list_memexes` (which is registered inline in `mcp/tools.ts`, not
// in `toolSpecs`, but IS in the manifest). When the two are in lockstep both
// arrays are empty.
//
// Side-effect-free and non-throwing at module load — the b-67 regression test
// calls this (and the broader MCP-surface check) and turns a non-empty result
// into a failure that points the reader at `packages/shared/src/tool-manifest.ts`.
export function manifestVsSpecsDiff(): {
  inSpecsNotManifest: string[];
  inManifestNotSpecs: string[];
} {
  // spec-360: AGENT_ONLY_SERVER_TOOLS (propose_scaffold_change) live on the
  // in-app agent only — never registered on MCP and intentionally absent from
  // the manifest, so they're excluded from this catalogue cross-check.
  const specNames = new Set(
    toolSpecs.map((s) => s.name).filter((name) => !AGENT_ONLY_SERVER_TOOLS.has(name)),
  );
  // `list_memexes` is the MCP-only inline tool — present in the manifest but
  // never in `toolSpecs`, so excluding it keeps a matched catalogue empty.
  const manifestNames = new Set(
    toolManifest.map((e) => e.name).filter((name) => name !== "list_memexes"),
  );

  const inSpecsNotManifest = [...specNames]
    .filter((name) => !manifestNames.has(name))
    .sort();
  const inManifestNotSpecs = [...manifestNames]
    .filter((name) => !specNames.has(name))
    .sort();

  return { inSpecsNotManifest, inManifestNotSpecs };
}
