// spec-366 (sol-1): per-domain tool handlers extracted from agent/tool-specs.ts.
// Each module owns one domain's ToolSpec entries (schema + handler);
// agent/tool-specs.ts composes them into the single `toolSpecs` catalogue.
// Infra (ToolCtx, helpers, guidance envelope) lives in ./shared.js (std-12).

import {
  z,
} from "zod";
// spec-566 dec-2 — the live-set rule, shared with the coverage helper itself so
// the headline and the breakdown below it can never count different rows.
import { isLiveAcStatus } from "@memex/shared";
import {
  buildChildRef,
} from "../../mcp/refs.js";
import {
  listDecisions,
} from "../../services/decisions.js";
import {
  createAc,
  listAcsForBrief,
  listAcsForBriefWithVerification,
  listResolvedDecisionImplAcCoverage,
  updateAc,
  deleteAc,
  linkAcToParent,
  listTestEventDigestForAc,
  discontinueTestEventsForAc,
  type AcKind,
  type AcStatus,
  type AcWithVerification,
} from "../../services/acs.js";
import {
  acceptAcSupersession,
  proposeAcSupersession,
  rejectAcSupersession,
} from "../../services/ac-supersession.js";
import { countGateOverridesForBriefs, overrideDoneGate } from "../../services/done-gate.js";
import {
  fetchTopic,
} from "../../services/guidance.js";
import {
  mintEphemeralEmissionKey,
} from "../../services/emission-keys.js";
import {
  ValidationError,
} from "../../types/errors.js";
import {
  formatAcCoverageSummary,
} from "./guidance-envelope.js";
import {
  VERBOSE_FIELD,
  isDocLikeKind,
  reqCtx,
  resolveRefArg,
  type ToolSpec,
} from "./tool-contract.js";

// ── Moved here from shared.ts by spec-546 t-2: this file is the symbol's only
// consumer, so it lives with its consumer and is private [per std-51].
/**
 * Resolve the current verification state of one AC (spec-127) so the
 * discontinue/restore write tools can report the badge result inline — the
 * agent sees immediately whether the retire cleared the red. Best-effort: any
 * lookup miss reports "unknown" rather than failing the (already-committed)
 * mutation.
 */
async function verificationStateForAc(
  memexId: string,
  briefId: string,
  acId: string,
): Promise<string> {
  try {
    const rows = await listAcsForBriefWithVerification(memexId, briefId);
    return rows.find((r) => r.ac.id === acId)?.verificationState ?? "unknown";
  } catch {
    return "unknown";
  }
}


export const acsTools: ToolSpec[] = [
  {
    name: "create_ac",
    annotations: { title: "Create acceptance criterion", readOnlyHint: false, destructiveHint: false },
    description:
      "Create an acceptance criterion (AC) under a Spec. Two flavours: " +
      "`kind: 'scope'` for manager-authored plain-English outcome commitments " +
      "(typically authored with the Spec and rendered with the Spec body), and " +
      "`kind: 'implementation'` for technical assertions spawned from a resolved " +
      "Decision (typically auto-accepted; pass `parent_decision_ref` to link). " +
      "ACs are addressable as `ac-N` and have zero or more tests in the codebase " +
      "that emit pass/fail events to POST /api/test-events tagged with the AC handle. " +
      "Before you write the verifying test for an implementation-kind AC you create here, " +
      "MUST call `get_information(topic='ac-emission')` if you haven't already — the " +
      "test-tagging mechanism is silent and undetectable if skipped.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the parent Spec, e.g. `mindset/main/specs/spec-N`.",
      ),
      kind: z.enum(["scope", "implementation"]).describe(
        "AC flavour: 'scope' for manager-authored outcome commitments, " +
        "'implementation' for agent-spawned technical assertions.",
      ),
      statement: z.string().describe(
        "The forward-facing statement of what the system must do. Plain English " +
        "for scope; technical/mechanism-shaped for implementation.",
      ),
      status: z.enum(["proposed", "active"]).optional().describe(
        "Initial status. Default 'active' (the auto-accept path). Use 'proposed' " +
        "for ACs that need explicit human review before they take effect.",
      ),
      parent_decision_ref: z.string().optional().describe(
        "Optional canonical ref to a parent Decision (for Implementation ACs), " +
        "e.g. `mindset/main/specs/spec-N/decisions/dec-N`. If omitted, no Decision " +
        "parent is recorded; for Scope ACs, the AC's parent is the Spec itself.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const kind = input.kind as AcKind;
      const statement = input.statement as string;
      const status = (input.status as AcStatus | undefined) ?? "active";
      const parentDecisionRef = input.parent_decision_ref as string | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `create_ac expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // Resolve optional parent Decision ref to its UUID.
      // The parent-kind discriminator is the DB `ac_parent_links.parent_kind`
      // value (CHECK IN ('brief','decision')); it stays "brief" — see
      // services/acs.ts ParentKind. Not the product noun.
      let parent: { kind: "brief" | "decision"; id: string } | undefined;
      if (parentDecisionRef) {
        const parentResolved = await resolveRefArg(ctx, parentDecisionRef, "parent_decision_ref");
        if (parentResolved.entity.kind !== "decision") {
          throw new ValidationError(
            `parent_decision_ref expects a decision ref; got ${parentResolved.entity.kind}.`,
          );
        }
        parent = { kind: "decision", id: parentResolved.entity.row.id };
      } else if (kind === "scope") {
        // Scope AC default parent: the Spec itself, so blast-radius cascades work.
        parent = { kind: "brief", id: doc.id };
      }

      const ac = await createAc({
        memexId,
        briefId: doc.id,
        kind,
        statement,
        status,
        parent,
      }, reqCtx(ctx));

      // spec-219 comb-through: count-aware AC call-to-action. The handler parks
      // DATA only; renderFooterSignal owns every word. For implementation ACs it
      // also parks the build-gate picture (resolved-decision coverage + open
      // decisions) so the footer can push toward build the moment it's earned —
      // the only phone-home Memex has for "stop lingering in specify while code is
      // being written". Sourced from the rubric's own coverage helper so the
      // footer and assess_spec speak with one voice. Net-new guidance.
      // spec-560 dec-2: DEFERRED, not computed here. These three reads happen after
      // `createAc` committed, and they exist only to decorate the footer — so a
      // transient in any of them used to turn a created AC into `Unexpected server
      // error` (ac-10). Parking a thunk moves them behind composeGuidanceEnvelope's
      // `afterCommit`; the closure keeps `doc` and `kind` without threading context.
      if (ctx.footerSlot) {
        ctx.footerSlot.compute = async () => {
          const sameKind = await listAcsForBrief(memexId, doc.id, { kind, status: "active" });
          let coverage:
            | { phase: string; resolvedCount: number; uncovered: string[]; open: string[] }
            | undefined;
          if (kind === "implementation") {
            const [allDecs, cov] = await Promise.all([
              listDecisions(memexId, doc.id),
              listResolvedDecisionImplAcCoverage(memexId, doc.id),
            ]);
            coverage = {
              phase: doc.status,
              resolvedCount: cov.length,
              uncovered: cov
                .filter((c) => c.implementationAcCount === 0)
                .map((c) => c.decisionHandle),
              open: allDecs.filter((d) => d.status === "open").map((d) => `dec-${d.seq}`),
            };
          }
          return {
            kind: "ac_created",
            acKind: kind,
            sameKindCount: sameKind.length,
            coverage,
          };
        };
      }

      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Created AC ${acRef} (${kind}, status=${status}): "${statement}"` +
          (parent ? ` linked to ${parent.kind}` : "");
      }
      return `ref: ${acRef} [${kind}, ${status}]`;
    },
  },
  {
    // spec-234: the agent-facing onboarding for AC emission. One call mints an
    // ephemeral, spec-scoped key AND returns the integration guidance — replacing the
    // "open Settings, mint a key, copy it, npm install a helper" detour. The key is
    // short-lived (so it's safe to return through the MCP transcript, dec-1/dec-5) and
    // scoped to this Spec. The guidance half is rendered from the SAME source as
    // get_information(topic='ac-emission-bootstrap'), never hand-copied (std-22, ac-16).
    name: "provision_ac_emission",
    annotations: { title: "Provision AC emission", readOnlyHint: false, destructiveHint: false },
    description:
      "Provision AC emission for the Spec you are working on, in one call: (1) mints a " +
      "working, ephemeral, spec-scoped emission key for this repo's Memex and returns the " +
      "raw value once, and (2) returns markdown guidance for wiring emission into whatever " +
      "test runner(s) the repo actually uses — authoring a native integration when no " +
      "official helper exists for the stack. No Settings-UI detour is needed; where an official " +
      "helper DOES exist for the detected stack, installing it is the expected path — the returned " +
      "guidance names which stacks have one. The key is short-lived (~2h) and may ONLY record " +
      "emissions for this Spec; use it in the test process environment for THIS session and " +
      "do not persist it — call again next session for a fresh key. For a long-lived CI key, " +
      "a human mints one in Settings → Emission Keys (this tool does not produce CI keys).",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the Spec you are working on, e.g. `mindset/main/specs/spec-N`. " +
          "The provisioned key is scoped to this Spec.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind) || resolved.doc.docType !== "spec") {
        throw new ValidationError(
          `provision_ac_emission expects a Spec ref (e.g. .../specs/spec-N); got ${resolved.entity.kind}/${resolved.doc.docType}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const specHandle = doc.handle; // e.g. "spec-3" — matches the ac_uid's /specs/<handle>/ segment
      const specRef = `${slugs.namespace}/${slugs.memex}/specs/${specHandle}`;

      // Member-level authority (dec-5): resolveRef already asserted the caller is a member of
      // this Memex, so minting here is the same authority as the Settings-UI mint. The minting
      // user is recorded (created_by_user_id) for audit.
      const minted = await mintEphemeralEmissionKey(memexId, specHandle, ctx.userId);
      const expiresAt = minted.row.expiresAt!; // always set for an ephemeral key

      // Render the protocol from the shared guidance source — NOT a hand-copied duplicate
      // (ac-16). This is the same body get_information(topic='ac-emission-bootstrap') serves.
      const bootstrap = await fetchTopic("ac-emission-bootstrap");

      return [
        `# AC emission provisioned for \`${specRef}\``,
        "",
        "## 1. Your emission key (use this session only — do NOT save it to disk)",
        "",
        "```",
        `MEMEX_EMIT_KEY=${minted.raw}`,
        "```",
        "",
        `- **Ephemeral:** this key expires at ${expiresAt.toISOString()} (~2h). It is **scoped to \`${specHandle}\`** — it can only record emissions for this Spec, nothing else on the board.`,
        "- **Do not persist it.** Export it into the environment of the test process for THIS session only " +
          "(e.g. `MEMEX_EMIT_KEY=… <run your tests>`). Do not write it to `.env`, CI config, or any file — " +
          "it will be expired by next session. When you start a fresh session, call `provision_ac_emission` " +
          "again for a new key.",
        "- **CI is different:** a long-lived key for a CI pipeline is minted by a human in Settings → Emission " +
          "Keys and stored as a CI secret. This tool only provisions the short-lived agent key.",
        "",
        "## 2. Wire emission into the repo's test runner(s)",
        "",
        "Detect the test runner(s) **this** repo actually uses (do not assume one). For each suite, look it up " +
          "in the helper table in the guidance below: **if an official Memex helper exists for that stack, " +
          "install it — that is the expected path**, not an optional accelerator, because a hand-rolled emitter " +
          "carries no version to bump and no fix shipped later can reach it. Hand-roll the native emitter only " +
          "where the table names none. A repo with multiple suites (e.g. a web suite plus a mobile/native suite) " +
          "wires emission into **every** suite, not just one, and each suite is looked up separately. Tag each " +
          "test with the AC ref it verifies and the emitter POSTs the result.",
        "",
        "---",
        "",
        bootstrap.body,
      ].join("\n");
    },
  },
  {
    name: "list_acs",
    annotations: { title: "List acceptance criteria", readOnlyHint: true, destructiveHint: false },
    description:
      "List acceptance criteria on a Spec, optionally filtered by `kind` " +
      "('scope' | 'implementation') or `status` ('proposed' | 'active' | 'rejected' | 'superseded'). " +
      "Each row carries its current verification state derived from `test_events`: " +
      "`verified` (all tagged tests pass) / `failing` (any latest emission is fail) / `stale` " +
      "(all pass but oldest is >7 days) / `untested` (no tagged tests yet). " +
      "**The header line shows coverage % (ACs with ≥1 tagged test) and verification %** so a quick glance " +
      "tells you where the gaps are. An AC sitting at 0 tests in build phase is silent debt — write a tagged " +
      "test before declaring any task done.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the Spec, e.g. `mindset/main/specs/spec-N`.",
      ),
      kind: z.enum(["scope", "implementation"]).optional().describe("Filter by AC flavour."),
      status: z.enum(["proposed", "active", "rejected", "superseded"]).optional().describe("Filter by status."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const kind = input.kind as AcKind | undefined;
      const status = input.status as AcStatus | undefined;

      const resolved = await resolveRefArg(ctx, ref);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `list_acs expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;

      // Use the verification-enriched service so every row carries its
      // test count + derived state. Filtering is client-side because the
      // service signature doesn't accept filters — the row set is tiny
      // (rarely > 50 ACs per Spec) so the JS pass is negligible.
      const allRows: AcWithVerification[] =
        await listAcsForBriefWithVerification(memexId, doc.id);
      let rows = allRows;
      if (kind) rows = rows.filter((r) => r.ac.kind === kind);
      if (status) rows = rows.filter((r) => r.ac.status === status);

      if (rows.length === 0) {
        return `No ACs on ${slugs.namespace}/${slugs.memex}/specs/${doc.handle} matching the filter.`;
      }

      // spec-207 ac-3 — a kind/status filter shrinks `rows`; surface how many
      // active ACs it hides so a filtered view can't silently understate the
      // gap. Counted over the active set on both sides (proposed/superseded ACs
      // aren't part of the "is this done?" signal).
      const filterActive = Boolean(kind || status);
      const hiddenByFilter = filterActive
        ? allRows.filter((r) => r.ac.status === "active").length -
          rows.filter((r) => r.ac.status === "active").length
        : 0;

      // Aggregate header — the coverage gap is the action signal. The agent
      // enumerates ACs constantly during build; spec-207 dec-1 routes the
      // headline through the shared `formatAcCoverageSummary` so it leads with
      // the not-verified gap (and the filter-hiding warning) instead of a
      // self-flattering "verified (of covered)" trophy.
      // spec-566 dec-2 — the breakdown counts the SAME population the headline
      // does, or the superseded criterion the headline just excluded reappears
      // one line down as an UNTESTED gap, and the response contradicts itself
      // inside a single payload (ac-13).
      const live = rows.filter((r) => isLiveAcStatus(r.ac.status));
      const covered = live.filter((r) => r.tests.length > 0).length;
      const untested = live.length - covered;
      const verified = live.filter((r) => r.verificationState === "verified").length;
      const failing = live.filter((r) => r.verificationState === "failing").length;
      const stale = live.filter((r) => r.verificationState === "stale").length;

      // spec-566 dec-2 — the superseded tally is counted over `allRows`, never
      // over the filtered set. `list_acs({ status: 'active' })` is the query an
      // agent runs to ask "is this Spec done?", and it is precisely the one that
      // would otherwise show a clean 100% with the retirement nowhere in sight.
      const supersededTotal = allRows.filter((r) => r.ac.status === "superseded").length;
      // dec-7 (ac-22): and the override count, on the same line, from the same
      // source every other coverage surface reads.
      const overrides = (await countGateOverridesForBriefs(memexId, [doc.id])).get(doc.id) ?? 0;
      const summary = formatAcCoverageSummary(rows, { hiddenByFilter, supersededTotal, overrides });
      // Full state distribution stays below the headline as a breakdown.
      const breakdown: string[] = [];
      if (verified > 0) breakdown.push(`${verified} verified`);
      if (failing > 0) breakdown.push(`${failing} failing`);
      if (stale > 0) breakdown.push(`${stale} stale`);
      if (untested > 0) breakdown.push(`${untested} UNTESTED`);

      // Decision-coverage line — mirrors the test-coverage signal one level
      // up: "how many resolved decisions have at least one implementation
      // AC?" A resolved decision without an implementation AC is a
      // commitment without a verification path; see guidance topic
      // `decisions-need-acs`. Best-effort — fails silently if the helper
      // throws so list_acs stays usable even if the join breaks.
      let decisionLine = "";
      try {
        const decCoverage = await listResolvedDecisionImplAcCoverage(
          memexId,
          doc.id,
        );
        if (decCoverage.length > 0) {
          const withAc = decCoverage.filter(
            (c) => c.implementationAcCount > 0,
          ).length;
          const nakedHandles = decCoverage
            .filter((c) => c.implementationAcCount === 0)
            .map((c) => c.decisionHandle);
          const naked = nakedHandles.length;
          decisionLine = `\n${decCoverage.length} resolved decision${decCoverage.length === 1 ? "" : "s"} · ${withAc}/${decCoverage.length} with implementation ACs`;
          if (naked > 0) {
            decisionLine += ` (NAKED: ${nakedHandles.join(", ")})`;
          }
        }
      } catch {
        // Best-effort.
      }

      const header = `${summary}\nBreakdown: ${breakdown.join(", ")}${decisionLine}`;

      // Per-row line — surfaces the AC's tagged-test count so the gap is
      // visible per AC, not just in the aggregate. UNTESTED is uppercase
      // so it pops in the agent's context.
      const lines = rows.map((r) => {
        const acRef = buildChildRef(slugs, doc, { type: "acs", seq: r.ac.seq });
        const testStatus =
          r.tests.length === 0
            ? "0 tests · UNTESTED"
            : `${r.tests.length} test${r.tests.length === 1 ? "" : "s"} · ${r.verificationState}`;
        return `- ref: ${acRef} [${r.ac.kind}, ${r.ac.status}] (${testStatus}) "${r.ac.statement}"`;
      });

      // Tail nudges: surface the two action signals when present —
      //   1. tests-missing: untested ACs need tagged tests
      //   2. ACs-missing-from-decisions: resolved decisions without
      //      implementation ACs are commitments without a verification path
      // Both cite their respective guidance topic so the agent can ground
      // the rule before acting.
      const tailParts: string[] = [];
      if (untested > 0) {
        tailParts.push(
          `${untested} AC${untested === 1 ? " is" : "s are"} untested. ` +
            `If you're in build / verify, write tagged tests for these before declaring any task done. ` +
            `See get_information(topic='test-coverage') for the discipline.`,
        );
      }
      try {
        const decCoverage = await listResolvedDecisionImplAcCoverage(
          memexId,
          doc.id,
        );
        const naked = decCoverage.filter((c) => c.implementationAcCount === 0);
        if (naked.length > 0) {
          const handles = naked.map((c) => c.decisionHandle).join(", ");
          tailParts.push(
            `${naked.length} resolved decision${naked.length === 1 ? "" : "s"} (${handles}) ${naked.length === 1 ? "has" : "have"} no implementation AC. ` +
              `Author at least one via \`create_ac({kind:'implementation', parent_decision_ref:'<dec-ref>', ...})\` before specify→build. ` +
              `See \`get_information(topic='decisions-need-acs')\` for the discipline.`,
          );
        }
      } catch {
        // Best-effort.
      }

      // spec-127 ac-6: orphan awareness. For every FAILING AC, name the
      // test_identifier(s) pinning it red and point to the ref-keyed retire
      // path — so an agent that just renamed/deleted a tagged test discovers
      // and clears its own orphan in-flow. We do NOT claim these ARE orphans
      // (the server can't tell "renamed away" from "failed for real"); we
      // surface the candidates + the affordance and leave the judgement to the
      // actor who knows the codebase (dec-1).
      const failingRows = rows.filter((r) => r.verificationState === "failing");
      if (failingRows.length > 0) {
        const pinLines = failingRows.map((r) => {
          const acRef = buildChildRef(slugs, doc, { type: "acs", seq: r.ac.seq });
          const ids = r.tests
            .filter((t) => t.latestStatus === "fail" || t.latestStatus === "error")
            .map((t) => `"${t.testIdentifier ?? "(no identifier)"}"`);
          return `- ${acRef} pinned by ${ids.join(", ")}`;
        });
        tailParts.push(
          `${failingRows.length} failing AC${failingRows.length === 1 ? "" : "s"} — if a pinning test was renamed/deleted in the codebase, ` +
            `it's an orphan: retire it with \`discontinue_test_events(ref, test_identifier)\` (inspect first with \`get_test_matrix(ref)\`). ` +
            `See \`get_information(topic='orphaned-test-events')\`.\n${pinLines.join("\n")}`,
        );
      }
      const tail = tailParts.length > 0 ? `\n\n${tailParts.join("\n\n")}` : "";

      return `${header}\n\n${lines.join("\n")}${tail}`;
    },
  },
  {
    name: "get_ac",
    annotations: { title: "Get acceptance criterion", readOnlyHint: true, destructiveHint: false },
    description:
      "Get a single AC by canonical ref. Returns the kind, status, statement, " +
      "and (in verbose mode) the full record.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-N/acs/ac-N`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `get_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = entity.row;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });

      // spec-127 ac-6: when this AC is held red, name the pinning identifier(s)
      // and point to the ref-keyed retire path, so an agent inspecting an AC it
      // just broke by renaming a test discovers and clears its own orphan. The
      // digest read is best-effort — a miss never fails get_ac.
      let orphanHint = "";
      try {
        const digest = await listTestEventDigestForAc(memexId, ac.id);
        const pinning = digest.filter((d) => d.pinning);
        if (pinning.length > 0) {
          const ids = pinning
            .map((d) => `"${d.testIdentifier === "" ? "(no identifier)" : d.testIdentifier}"`)
            .join(", ");
          orphanHint =
            `\n⚠ This AC reads failing — pinned by ${ids}. If a pinning test was renamed/deleted in the codebase, ` +
            `it's an orphan: retire it with \`discontinue_test_events(ref="${acRef}", test_identifier=…)\` ` +
            `(inspect with \`get_test_matrix(ref="${acRef}")\`). See \`get_information(topic='orphaned-test-events')\`.`;
        }
      } catch {
        // Best-effort.
      }

      if (ctx.verbose) {
        return `ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}, status=${ac.status}): "${ac.statement}"${orphanHint}`;
      }
      return `ref: ${acRef} [${ac.kind}, ${ac.status}] "${ac.statement}"${orphanHint}`;
    },
  },
  {
    name: "get_test_matrix",
    annotations: {
      title: "Read an AC's test-event matrix",
      readOnlyHint: true,
      destructiveHint: false,
    },
    description:
      "Read the per-`test_identifier` test-event digest for one AC, keyed by its " +
      "canonical ref. One row per identifier: latest (non-hidden) status, last run " +
      "time, emission count, and two flags — `PINNING red` (this identifier's latest " +
      "emission is fail/error, so it holds the AC red) and `retired (hidden)` (a legacy " +
      "hidden row, invisible to the verdict — kept for audit; the column is frozen). " +
      "Use this when an AC reads `failing`/`stale` " +
      "to find WHICH identifier is responsible — then, if you renamed/deleted that test " +
      "in the codebase, retire its orphan with `discontinue_test_events`. See " +
      "`get_information(topic='orphaned-test-events')`.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-N/acs/ac-N`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `get_test_matrix expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const rows = await listTestEventDigestForAc(memexId, entity.row.id);
      if (rows.length === 0) {
        return `ref: ${acRef}\nNo test events recorded for this AC yet.`;
      }
      const lines = rows.map((r) => {
        const id = r.testIdentifier === "" ? "(no identifier)" : r.testIdentifier;
        const status = r.hidden ? "retired" : (r.latestStatus ?? "—");
        const last = r.latestRunAt ? r.latestRunAt.toISOString() : "—";
        const flags: string[] = [];
        if (r.pinning) flags.push("PINNING red");
        if (r.hidden) flags.push("retired (hidden)");
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        return `- ${id} — latest ${status}, ${r.count} emission${r.count === 1 ? "" : "s"}, last ${last}${flagStr}`;
      });
      return `ref: ${acRef}\n${lines.join("\n")}`;
    },
  },
  {
    name: "discontinue_test_events",
    annotations: {
      title: "Discontinue (hard-delete) an orphaned test_identifier",
      readOnlyHint: false,
      destructiveHint: true,
    },
    description:
      "Retire an orphaned `test_identifier` on an AC — a test you renamed/moved/deleted " +
      "in the codebase whose last emission still pins the AC red. HARD DELETE, irreversible " +
      "It removes the matching emissions and clears their verification summary, " +
      "the same thing the UI 'Delete test events' button does. There is no undo — but a " +
      "fresh live emission of the same identifier re-enters the verdict on its own. Only " +
      "retire an identifier you KNOW no longer exists in the codebase — not one that merely " +
      "wasn't run this round. Find the identifier with `get_test_matrix`.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-N/acs/ac-N`.",
      ),
      test_identifier: z.string().describe(
        "The exact test_identifier to retire (as shown by get_test_matrix), " +
          "e.g. `tests/cache.test.ts::uses redis`.",
      ),
      reason: z.string().describe(
        "Why this evidence is being retired — what actually happened to the test " +
          "(renamed, deleted, moved, superseded by another test). REQUIRED: the " +
          "emissions are hard-deleted, and this sentence is the only thing left " +
          "behind. Say what you observed, not that it was 'no longer needed'.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      // Resolve the ref FIRST so the std-10 UUID boundary guard fires before
      // any other validation (b-36 D-7 — the canonical error must win).
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `discontinue_test_events expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const testIdentifier = input.test_identifier as string;
      if (!testIdentifier?.trim()) {
        throw new ValidationError("test_identifier is required.");
      }
      const { memexId, doc, slugs, entity } = resolved;
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: entity.row.seq });
      const reason = input.reason as string;
      if (!reason?.trim()) {
        throw new ValidationError(
          "reason is required — a retirement hard-deletes evidence and the record of why is all that survives it.",
        );
      }
      const result = await discontinueTestEventsForAc(
        memexId,
        entity.row.id,
        testIdentifier,
        reason,
        // spec-566 t-4: thread the invoking surface so the retirement is attributed
        // to the actor (mcp vs in_app_agent) rather than defaulting to channel
        // 'server' — "who retired this evidence" is exactly the question the
        // activity contract exists to answer [per std-32].
        reqCtx(ctx),
      );
      const state = await verificationStateForAc(memexId, doc.id, entity.row.id);
      if (result.deleted === 0) {
        return `ref: ${acRef} — no emissions matched "${testIdentifier}"; nothing retired. AC verification: ${state}.`;
      }
      return `ref: ${acRef} — retired (hard-deleted) ${result.deleted} emission${result.deleted === 1 ? "" : "s"} of "${testIdentifier}". AC verification is now: ${state}. This is irreversible; a fresh live emission re-enters the verdict.`;
    },
  },
  {
    name: "link_ac_to_decision",
    annotations: { title: "Link AC to a parent Decision", readOnlyHint: false, destructiveHint: false },
    description:
      "Add a parent-Decision link to an existing AC. Used when an AC needs to be " +
      "associated with a Decision that wasn't its origin (e.g. cross-cutting " +
      "Implementation ACs spawned from multiple Decisions). For typical " +
      "Decision-spawned ACs, pass the parent_decision_ref argument to create_ac instead.",
    schema: {
      ac_ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-N/acs/ac-N`.",
      ),
      decision_ref: z.string().describe(
        "Canonical ref to the parent Decision, e.g. `mindset/main/specs/spec-N/decisions/dec-N`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const acRefArg = input.ac_ref as string;
      const decisionRef = input.decision_ref as string;

      const acResolved = await resolveRefArg(ctx, acRefArg, "ac_ref");
      if (acResolved.entity.kind !== "ac") {
        throw new ValidationError(
          `ac_ref expects an ac ref; got ${acResolved.entity.kind}.`,
        );
      }
      const parentResolved = await resolveRefArg(ctx, decisionRef, "decision_ref");
      if (parentResolved.entity.kind !== "decision") {
        throw new ValidationError(
          `decision_ref expects a decision ref; got ${parentResolved.entity.kind}.`,
        );
      }
      await linkAcToParent(acResolved.memexId, acResolved.entity.row.id, {
        kind: "decision",
        id: parentResolved.entity.row.id,
      });
      const acRefOut = buildChildRef(acResolved.slugs, acResolved.doc, {
        type: "acs",
        seq: acResolved.entity.row.seq,
      });
      const decRefOut = buildChildRef(parentResolved.slugs, parentResolved.doc, {
        type: "decisions",
        seq: parentResolved.entity.row.seq,
      });
      return `Linked ref: ${acRefOut} to ref: ${decRefOut}`;
    },
  },
  {
    name: "update_ac",
    annotations: { title: "Update AC statement", readOnlyHint: false, destructiveHint: false },
    description:
      "Update the statement text of an existing AC. Only the statement is " +
      "mutable here; kind is fixed at creation, and status transitions go " +
      "through accept_ac / reject_ac. Use this to polish wording, sharpen " +
      "falsifiability, or fix typos while a criterion is still unsatisfied. " +
      "REFUSES a criterion that already reads as satisfied — one verified by a " +
      "passing test, or manually accepted — because editing it would " +
      "retroactively change what those passing tests proved. Route that change " +
      "through propose_ac_supersession, which records the decision authorising " +
      "it and leaves the original statement intact.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-N/acs/ac-N`.",
      ),
      statement: z.string().describe("New statement text. Must be non-empty."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const statement = input.statement as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `update_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = await updateAc(memexId, entity.row.id, statement, reqCtx(ctx));
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Updated ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}, status=${ac.status}): "${ac.statement}"`;
      }
      return `Updated ref: ${acRef} [${ac.kind}, ${ac.status}]`;
    },
  },
  {
    name: "delete_ac",
    annotations: { title: "Delete AC", readOnlyHint: false, destructiveHint: true },
    description:
      "Hard-delete an AC. FK cascades remove its parent links and any " +
      "task_satisfies_ac rows pointing at it. Prefer reject_ac (status " +
      "transition, preserves history) over delete for ACs that were " +
      "considered and dismissed; delete is for accidents or duplicates.",
    schema: {
      ref: z.string().describe(
        "Canonical ref to the AC, e.g. `mindset/main/specs/spec-N/acs/ac-N`.",
      ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const ref = input.ref as string;
      const resolved = await resolveRefArg(ctx, ref);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `delete_ac expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const ac = await deleteAc(memexId, entity.row.id);
      const acRef = buildChildRef(slugs, doc, { type: "acs", seq: ac.seq });
      if (ctx.verbose) {
        return `Deleted ref: ${acRef} (seq=${ac.seq}, kind=${ac.kind}) "${ac.statement}"`;
      }
      return `Deleted ref: ${acRef}`;
    },
  },

  // ── AC supersession (spec-566 t-2, dec-1 option C) ───────
  //
  // The price of changing a criterion's meaning. `update_ac` above stays the free
  // call for polishing wording; these three are what a MATERIAL change costs — a
  // proposal a human accepts, in the same Drift Inbox queue standards proposals
  // already use. Every one of them is a `render_confirmation` act, never something
  // the agent completes on its own.
  {
    name: "propose_ac_supersession",
    annotations: { title: "Propose AC supersession", readOnlyHint: false, destructiveHint: false },
    description:
      "Propose that an acceptance criterion be superseded — the call to make when later work REVERSES a criterion, rather than rewriting it with update_ac. " +
      "This changes NOTHING: the statement stays byte-identical and the verification verdict is untouched until a human accepts. " +
      "You must name the superseding decision (`decision_ref`) — a reversal with no recorded reason is exactly what this verb exists to prevent — and you never supply the criterion's current text: the server reads it, so the accept can tell whether the criterion moved underneath the proposal. " +
      "Omit `proposed_statement` to retire a criterion with no replacement. Propose this through `render_confirmation` FIRST and never call it until the user confirms.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the criterion, e.g. `<ns>/<mx>/specs/spec-N/acs/ac-N`. NOT a UUID."),
      decision_ref: z
        .string()
        .describe(
          "Canonical ref to the superseding decision, e.g. `<ns>/<mx>/specs/spec-N/decisions/dec-M`. Mandatory. NOT a UUID.",
        ),
      proposed_statement: z
        .string()
        .optional()
        .describe("The replacement statement. Omit to supersede with no successor."),
      rationale: z.string().optional().describe("Why the criterion is being reversed."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const resolved = await resolveRefArg(ctx, input.ref as string);
      if (resolved.entity.kind !== "ac") {
        throw new ValidationError(
          `propose_ac_supersession expects an ac ref; got ${resolved.entity.kind}.`,
        );
      }
      // std-10: the decision is addressed by its canonical dec-N ref, and
      // resolveRefArg is what rejects a raw UUID at the boundary — the same guard
      // the `ref` argument gets, rather than a parallel check of our own (ac-18).
      const resolvedDecision = await resolveRefArg(ctx, input.decision_ref as string);
      if (resolvedDecision.entity.kind !== "decision") {
        throw new ValidationError(
          `propose_ac_supersession expects a decision ref for decision_ref; got ${resolvedDecision.entity.kind}.`,
        );
      }

      const { memexId, doc, slugs, entity } = resolved;
      const result = await proposeAcSupersession(
        {
          memexId,
          acId: entity.row.id,
          decisionId: resolvedDecision.entity.row.id,
          proposedStatement: (input.proposed_statement as string | undefined) ?? null,
          rationale: input.rationale as string | undefined,
        },
        reqCtx(ctx),
      );
      const commentRef = buildChildRef(slugs, doc, {
        type: "comments",
        seq: result.comment.seq,
      });
      return (
        `Supersession PROPOSED (ref: ${commentRef}) — nothing has changed yet. ` +
        `The criterion still reads as it did and keeps its current verdict; a human accepts it with accept_ac_supersession(${commentRef}).`
      );
    },
  },
  {
    name: "accept_ac_supersession",
    annotations: { title: "Accept AC supersession", readOnlyHint: false, destructiveHint: false },
    description:
      "Accept an open supersession proposal. The criterion is retired — its statement PRESERVED verbatim, its status set to superseded — and, where the proposal carried one, a replacement criterion is created under the superseding decision with no test evidence of its own, so the tests must earn its verdict against the new text. All of it in one transaction. " +
      "Takes the proposal's comment ref and nothing else, so what lands is exactly what was reviewed. REFUSES, naming the current text, if the criterion changed after the proposal was written. Propose through `render_confirmation` FIRST.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the proposal comment, e.g. `<ns>/<mx>/specs/spec-N/comments/c-N`. NOT a UUID.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const resolved = await resolveRefArg(ctx, input.ref as string);
      if (resolved.entity.kind !== "comment") {
        throw new ValidationError(
          `accept_ac_supersession takes a proposal comment ref (c-N); got ${resolved.entity.kind} for "${input.ref as string}".`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const result = await acceptAcSupersession(memexId, entity.row.id, reqCtx(ctx));
      const retiredRef = buildChildRef(slugs, doc, {
        type: "acs",
        seq: result.superseded.seq,
      });
      if (!result.successor) {
        return `Superseded ref: ${retiredRef} — retired with no replacement. Its statement is preserved as written.`;
      }
      const successorRef = buildChildRef(slugs, doc, {
        type: "acs",
        seq: result.successor.seq,
      });
      return (
        `Superseded ref: ${retiredRef} (statement preserved as written) and created ref: ${successorRef} in its place. ` +
        `${successorRef} is UNTESTED — it earns its own verdict; the old evidence stays attached to the criterion that earned it.`
      );
    },
  },
  {
    name: "reject_ac_supersession",
    annotations: { title: "Reject AC supersession", readOnlyHint: false, destructiveHint: false },
    description:
      "Decline an open supersession proposal. The criterion is untouched; only the proposal closes, resolved 'rejected'. Propose through `render_confirmation` FIRST.",
    schema: {
      ref: z
        .string()
        .describe(
          "Canonical ref to the proposal comment, e.g. `<ns>/<mx>/specs/spec-N/comments/c-N`. NOT a UUID.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const resolved = await resolveRefArg(ctx, input.ref as string);
      if (resolved.entity.kind !== "comment") {
        throw new ValidationError(
          `reject_ac_supersession takes a proposal comment ref (c-N); got ${resolved.entity.kind} for "${input.ref as string}".`,
        );
      }
      const { memexId, doc, slugs, entity } = resolved;
      const comment = await rejectAcSupersession(memexId, entity.row.id, reqCtx(ctx));
      const commentRef = buildChildRef(slugs, doc, { type: "comments", seq: comment.seq });
      return `Rejected ref: ${commentRef}. The criterion is unchanged.`;
    },
  },
  {
    name: "override_done_gate",
    annotations: { title: "Override the done-gate", readOnlyHint: false, destructiveHint: false },
    description:
      "Close a Spec over an unaccepted supersession proposal, on the record. The done-gate refuses to certify a Spec holding a criterion whose rewrite nobody accepted; this is the sanctioned way past it. Records who, when and why, and the count is rendered beside the Spec's coverage from then on — an override is visible, not quiet. " +
      "Deciding the proposal with accept_ac_supersession or reject_ac_supersession is the ordinary path; reach for this only when neither is right. REFUSES without a stated reason, and refuses when nothing is actually blocked. Propose through `render_confirmation` FIRST.",
    schema: {
      ref: z
        .string()
        .describe("Canonical ref to the Spec, e.g. `<ns>/<mx>/specs/spec-N`. NOT a UUID."),
      reason: z
        .string()
        .describe(
          "Why this Spec closes with the rewrite unaccepted. Recorded verbatim against your name — the server never invents one.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const resolved = await resolveRefArg(ctx, input.ref as string);
      if (!isDocLikeKind(resolved.entity.kind)) {
        throw new ValidationError(
          `override_done_gate expects a doc-level (Spec) ref; got ${resolved.entity.kind}.`,
        );
      }
      const { memexId, doc, slugs } = resolved;
      const result = await overrideDoneGate(
        memexId,
        doc.id,
        input.reason as string,
        reqCtx(ctx),
      );
      const specRef = `${slugs.namespace}/${slugs.memex}/specs/${doc.handle}`;
      const n = result.overriddenCount;
      return (
        `Overrode ref: ${specRef} — the done-gate is clear over ${n} unaccepted supersession proposal${n === 1 ? "" : "s"}. ` +
        `Your name, the time and your reason are on the record, and the override count now renders beside this Spec's coverage. ` +
        `A proposal filed after this one re-arms the gate.`
      );
    },
  },

  // ── Task CRUD ────────────────────────────────────────────
];
