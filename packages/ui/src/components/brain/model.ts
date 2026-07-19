// spec-498 — the Brain view's pure model: the projection from the spec-497
// knowledge-graph payload (facets, standards, specs, decisions + typed edges)
// into the spec-496 map engine's SimGraph shape. Everything Brain-specific
// lives here (dec-1): type hues, the rose drift override, edge selection,
// per-type deep links. Deliberately free of pixi.js / d3-force imports —
// jsdom tests own this mapping while the shared WebGL renderer stays
// browser-only.
//
// Colour semantics (dec-2, derived from std-27's CHART_PALETTES so the
// encoding can never drift from the shared chart language): facet = amber
// (specify), spec = blue (build), decision = cyan (verify), standard =
// emerald (done) — and drift = the reserved rose failure hue, overriding the
// type hue on any node an open drift touches. Red always means attention.

import type { KnowledgeGraphData } from '../../api/insights';
import { CHART_PALETTES } from '../insights/theme';
import { nodeRadius, type EvidenceItem, type SimLink, type SimNode } from '../standards-map/model';

export type BrainNodeKind = 'facet' | 'standard' | 'spec' | 'decision';

/** The Brain relationship families — carried for tests + evidence routing. */
export type BrainRel = 'spec-decision' | 'decision-facet' | 'standard-facet' | 'mention' | 'drift';

export interface BrainNode extends SimNode {
  kind: BrainNodeKind;
  /** Tenant-relative deep link — null for facets (no page; std-34 honest CTA). */
  href: string | null;
  /** One-line focus-card detail (counts / status / facet description). */
  detail: string;
  /** True when an open drift touches this node — the rose fill applies. */
  drifted: boolean;
}

export interface BrainLink extends SimLink {
  rel: BrainRel;
  /** Where a click on this edge navigates (drift → the Drift Inbox, filtered). */
  href?: string;
}

export interface BrainGraph {
  nodes: BrainNode[];
  links: BrainLink[];
}

/** The five Brain hues for a theme — every value comes from CHART_PALETTES. */
export interface BrainPalette {
  facet: number;
  spec: number;
  decision: number;
  standard: number;
  drift: number;
}

const hex = (s: string): number => parseInt(s.slice(1), 16);

export function brainPalette(theme: 'dark' | 'light'): BrainPalette {
  const p = CHART_PALETTES[theme];
  return {
    facet: hex(p.phase.specify),
    spec: hex(p.phase.build),
    decision: hex(p.phase.verify),
    standard: hex(p.phase.done),
    drift: hex(p.verification.failing),
  };
}

/** 'cl-7' → 7; anything unparsable degrades to null (EvidenceItem shape). */
function clauseSeqOf(clauseHandle: string): number | null {
  const n = Number(clauseHandle.replace(/^cl-/, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The pure projection (dec-1): one node per facet/standard/spec/decision,
 * links for containment (spec→decision), ballots (decision→facet), clause
 * tags (standard→facet), clause mentions (standard↔standard), and drift
 * (decision→standard). Semantic-similarity edges are deliberately dropped
 * (dec-3) — Brain shows concrete connections only. Links whose endpoint fell
 * outside the payload's node set (e.g. a drift edge whose decision the filter
 * excluded) are skipped: the drifted STANDARD still reads rose via
 * openDriftCount, so no signal is lost, and d3-force never sees a dangling
 * reference.
 */
export function buildBrainGraph(data: KnowledgeGraphData, palette: BrainPalette): BrainGraph {
  const specHandleById = new Map(data.nodes.specs.map((s) => [s.docId, s.handle]));
  const specByDecision = new Map(data.edges.specDecision.map((e) => [e.decisionId, e.specDocId]));
  const driftedDecisions = new Set(data.edges.drift.map((e) => e.decisionId));

  const nodes: BrainNode[] = [];

  for (const f of data.nodes.facets) {
    nodes.push({
      id: f.id,
      kind: 'facet',
      handle: f.key,
      title: f.name ?? f.key,
      // A facet's handle IS its name (key ≈ slugified name), so the engine's
      // default `handle · title` label would read duplicated
      // ("performance · Performance") — label with the display name alone.
      label: f.name ?? f.key,
      clauseCount: 0,
      degree: 0,
      radius: 0,
      color: palette.facet,
      href: null,
      detail:
        `${f.description ? `${f.description} — ` : ''}` +
        `${f.standardCount} standard${f.standardCount === 1 ? '' : 's'}, ` +
        `${f.decisionCount} decision${f.decisionCount === 1 ? '' : 's'}`,
      drifted: false,
    });
  }
  for (const s of data.nodes.standards) {
    const drifted = s.openDriftCount > 0;
    nodes.push({
      id: s.docId,
      kind: 'standard',
      handle: s.handle,
      title: s.title,
      clauseCount: s.clauseCount,
      degree: 0,
      radius: 0,
      color: drifted ? palette.drift : palette.standard,
      href: `/standards/${s.handle}`,
      detail: drifted
        ? `standard — ${s.openDriftCount} open drift comment${s.openDriftCount === 1 ? '' : 's'}`
        : `standard — ${s.clauseCount} clause${s.clauseCount === 1 ? '' : 's'}`,
      drifted,
    });
  }
  for (const s of data.nodes.specs) {
    nodes.push({
      id: s.docId,
      kind: 'spec',
      handle: s.handle,
      title: s.title,
      clauseCount: 0,
      degree: 0,
      radius: 0,
      color: palette.spec,
      href: `/specs/${s.handle}`,
      detail: `spec — ${s.status}, ${s.decisionCount} decision${s.decisionCount === 1 ? '' : 's'}`,
      drifted: false,
    });
  }
  for (const d of data.nodes.decisions) {
    const drifted = driftedDecisions.has(d.id);
    const specDocId = specByDecision.get(d.id);
    const specHandle = specDocId ? specHandleById.get(specDocId) : undefined;
    nodes.push({
      id: d.id,
      kind: 'decision',
      handle: d.handle,
      title: d.title,
      clauseCount: 0,
      degree: 0,
      radius: 0,
      color: drifted ? palette.drift : palette.decision,
      href: specHandle ? `/specs/${specHandle}/decisions/${d.handle}` : null,
      drifted,
      detail: drifted ? `decision — ${d.status}, drift open against a standard` : `decision — ${d.status}`,
    });
  }

  const present = new Set(nodes.map((n) => n.id));
  const links: BrainLink[] = [];
  const push = (
    rel: BrainRel,
    source: string,
    target: string,
    extra: Partial<Pick<BrainLink, 'width' | 'color' | 'count' | 'evidence' | 'href'>> = {},
  ) => {
    if (!present.has(source) || !present.has(target)) return;
    links.push({
      id: `${rel}:${source}->${target}`,
      source,
      target,
      kind: 'mention',
      width: extra.width ?? 0.7,
      rel,
      ...extra,
    });
  };

  for (const e of data.edges.specDecision) push('spec-decision', e.specDocId, e.decisionId);
  for (const e of data.edges.decisionFacet) push('decision-facet', e.decisionId, e.facetId);

  const maxFacetClauses = Math.max(...data.edges.standardFacet.map((e) => e.clauseCount), 1);
  for (const e of data.edges.standardFacet) {
    push('standard-facet', e.standardDocId, e.facetId, {
      width: 0.6 + (e.clauseCount / maxFacetClauses) * 1.2,
      count: e.clauseCount,
      evidence: e.evidence.map(
        (ev): EvidenceItem => ({ clauseSeq: clauseSeqOf(ev.clauseHandle), snippet: ev.snippet }),
      ),
    });
  }

  const maxMentions = Math.max(...data.edges.mentions.map((e) => e.count), 1);
  for (const e of data.edges.mentions) {
    push('mention', e.sourceDocId, e.targetDocId, {
      width: 0.6 + (e.count / maxMentions) * 1.8,
      count: e.count,
      evidence: e.evidence,
    });
  }

  // Drift last: the rose thread (dec-2) — wider than everything else so the
  // one red edge on the surface reads at constellation zoom. Clicking it lands
  // on THAT drift item in the Drift Inbox: filtered to the drifted standard
  // (?doc=std-N) AND deep-linked to the specific comment (&drift=<commentId>),
  // so the click-through is to the exact drift, not just the standard's list.
  const standardHandleById = new Map(data.nodes.standards.map((s) => [s.docId, s.handle]));
  for (const e of data.edges.drift) {
    const standardHandle = standardHandleById.get(e.standardDocId);
    push('drift', e.decisionId, e.standardDocId, {
      width: 1.6,
      color: palette.drift,
      href: standardHandle ? `/drift?doc=${standardHandle}&drift=${e.commentId}` : undefined,
    });
  }
  // data.edges.semantic is intentionally unused (dec-3).

  const degree = new Map<string, number>();
  for (const l of links) {
    const s = l.source as string;
    const t = l.target as string;
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }
  for (const n of nodes) {
    n.degree = degree.get(n.id) ?? 0;
    n.radius = nodeRadius(n.degree);
  }

  return { nodes, links };
}
