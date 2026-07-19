// spec-179 (t-8): the pure model for the standards network map — the data
// shapes d3-force simulates and PIXI renders, plus the interaction math
// (label fade, hover neighborhood). Deliberately free of pixi.js / d3-force
// imports: jsdom tests own this mapping while the WebGL renderer stays
// browser-only (same testing posture as the React Flow mapper this replaces —
// see amended dec-1).
//
// spec-496 adds the Obsidian-grade layer: mention-edge cluster detection and
// its palette mapping (dec-2), the easing/ticker-sleep math (dec-3), the
// directional-flow edge selection (dec-4), and the local-graph focus set
// (dec-5) — all pure and jsdom-tested here, consumed by the renderer.

import type { StandardsGraphData } from '../../api/client';
import { CHART_PALETTES } from '../insights/theme';

export type EvidenceItem = { clauseSeq: number | null; snippet: string | null };

export interface SimNode {
  /** docId — the simulation identity. */
  id: string;
  handle: string;
  title: string;
  clauseCount: number;
  /** Mention-edge degree — connectedness, drives node radius (s-3). */
  degree: number;
  radius: number;
  /**
   * Mention-edge community (spec-496 dec-2) — indexes into the palette's
   * clusterHues. Undefined for nodes with no mention edges (they keep the
   * neutral slate).
   */
  cluster?: number;
  /**
   * Explicit fill override (spec-498 dec-1) — set by graphs that encode
   * meaning in colour (the Brain view's type hues). Wins over cluster/neutral
   * in nodeColor(), and such nodes keep their own hue under hover/search
   * emphasis (glow + label carry the emphasis instead).
   */
  color?: number;
  /**
   * Explicit label override (spec-498) — the renderer's default is
   * `handle · title`, which duplicates for nodes whose handle IS their name
   * (Brain facets: `performance · Performance`). Absent = the default.
   */
  label?: string;
  // d3-force mutates these in place during the simulation.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface SimLink {
  id: string;
  /** d3-force rewrites string ids to live node refs once the sim starts. */
  source: string | SimNode;
  target: string | SimNode;
  kind: 'mention' | 'semantic';
  /** Stroke width — mention edges scale with citing-clause count. */
  width: number;
  /**
   * Explicit calm-stroke override (spec-498 dec-1) — e.g. the Brain view's
   * rose drift edges. An overridden edge keeps its own colour under emphasis
   * (alpha still rises); absent, the palette mention/semantic strokes apply.
   */
  color?: number;
  /**
   * Continuous-flow override (spec-498): when true AND the renderer runs in
   * `continuousFlow` mode, this edge animates its dash-flow ALWAYS, regardless of
   * focus/hover — and is the ONLY kind of edge that flows. The Brain marks its
   * rose drift edges with this so drift is the map's one live signal; every other
   * edge stays a thin static line. Ignored by the default (StandardsMap) renderer.
   */
  flow?: boolean;
  count?: number;
  evidence?: EvidenceItem[];
  similarity?: number;
}

export interface SimGraph {
  nodes: SimNode[];
  links: SimLink[];
}

/** Connectedness → radius: sqrt keeps hubs prominent without dwarfing leaves. */
export function nodeRadius(degree: number): number {
  return Math.min(5 + 2.5 * Math.sqrt(degree), 18);
}

// ── Cluster detection (spec-496 dec-2) ───────────────────────────────────────

/**
 * Label-propagation communities over the mention-edge graph. Deterministic:
 * nodes iterate in stable sorted-id order, labels start as each node's index
 * in that order, and ties resolve to the smallest label — the same graph
 * always yields the same assignment. Nodes with no mention edges are absent
 * from the result (unclustered → neutral slate). No dependency; ~O(E·rounds)
 * and standards graphs are tens of nodes.
 */
export function clusterAssignments(
  nodeIds: string[],
  mentionEdges: Array<{ sourceDocId: string; targetDocId: string }>,
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const e of mentionEdges) {
    if (e.sourceDocId === e.targetDocId) continue;
    (adjacency.get(e.sourceDocId) ?? adjacency.set(e.sourceDocId, []).get(e.sourceDocId)!).push(
      e.targetDocId,
    );
    (adjacency.get(e.targetDocId) ?? adjacency.set(e.targetDocId, []).get(e.targetDocId)!).push(
      e.sourceDocId,
    );
  }

  const connected = [...nodeIds].filter((id) => adjacency.has(id)).sort();
  const label = new Map<string, number>(connected.map((id, i) => [id, i]));

  const MAX_ROUNDS = 20;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    for (const id of connected) {
      const counts = new Map<number, number>();
      for (const nb of adjacency.get(id) ?? []) {
        const l = label.get(nb);
        if (l === undefined) continue;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      let best = label.get(id)!;
      let bestCount = 0;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Renumber to compact cluster ids, ordered by first appearance in sorted
  // node order, so colours stay stable across visits.
  const renumber = new Map<number, number>();
  const result = new Map<string, number>();
  for (const id of connected) {
    const raw = label.get(id)!;
    if (!renumber.has(raw)) renumber.set(raw, renumber.size);
    result.set(id, renumber.get(raw)!);
  }
  return result;
}

/**
 * The fill colour for a node: an explicit override first (spec-498 dec-1 —
 * graphs that encode meaning in colour), then its cluster's hue (cycling when
 * clusters outnumber hues), then the neutral node colour. The accent stays
 * reserved for hover/search/semantic emphasis (std-27 cl-3).
 */
export function nodeColor(node: Pick<SimNode, 'cluster' | 'color'>, palette: MapPalette): number {
  if (node.color !== undefined) return node.color;
  if (node.cluster === undefined || palette.clusterHues.length === 0) return palette.node;
  return palette.clusterHues[node.cluster % palette.clusterHues.length];
}

/**
 * Pure mapping from the analytics graph payload to simulation nodes + links.
 * Exported for unit testing — the renderer trusts whatever this returns.
 */
export function buildSimGraph(
  graph: StandardsGraphData,
  opts: { showSemantic: boolean },
): SimGraph {
  const degree = new Map<string, number>();
  for (const e of graph.mentionEdges) {
    degree.set(e.sourceDocId, (degree.get(e.sourceDocId) ?? 0) + 1);
    degree.set(e.targetDocId, (degree.get(e.targetDocId) ?? 0) + 1);
  }

  const clusters = clusterAssignments(
    graph.nodes.map((n) => n.docId),
    graph.mentionEdges,
  );

  const nodes: SimNode[] = graph.nodes.map((n) => {
    const d = degree.get(n.docId) ?? 0;
    return {
      id: n.docId,
      handle: n.handle,
      title: n.title,
      clauseCount: n.clauseCount,
      degree: d,
      radius: nodeRadius(d),
      cluster: clusters.get(n.docId),
    };
  });

  const maxCount = Math.max(...graph.mentionEdges.map((e) => e.count), 1);
  const links: SimLink[] = graph.mentionEdges.map((e) => ({
    id: `mention:${e.sourceDocId}->${e.targetDocId}`,
    source: e.sourceDocId,
    target: e.targetDocId,
    kind: 'mention' as const,
    // Obsidian-style hairlines: 0.6px base, heaviest citation pair tops out
    // at 2.4px — weight should read as a whisper, not a pipe.
    width: 0.6 + (e.count / maxCount) * 1.8,
    count: e.count,
    evidence: e.evidence,
  }));

  if (opts.showSemantic) {
    for (const e of graph.semanticEdges) {
      links.push({
        id: `semantic:${e.sourceDocId}->${e.targetDocId}`,
        source: e.sourceDocId,
        target: e.targetDocId,
        kind: 'semantic',
        width: 0.8,
        similarity: e.similarity,
      });
    }
  }

  return { nodes, links };
}

/**
 * Label opacity for a world zoom level — the Obsidian fade-in: labels are
 * fully present at the initial fit (capped at 1×) and only fade away as you
 * zoom OUT toward the constellation view. The renderer counter-scales the
 * labels so they hold a constant screen size instead of ballooning with
 * zoom. Hovering reveals a node's neighborhood labels at any zoom.
 */
export function labelAlphaForZoom(scale: number): number {
  return Math.max(0, Math.min(1, (scale - 0.5) / 0.4));
}

/**
 * Case-insensitive substring match over handle + title — the ONE search
 * semantic shared by the map highlight and the list filter, so the same
 * query means the same thing in both views. Empty query matches everything.
 */
export function matchesQuery(query: string, handle: string, title: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return handle.toLowerCase().includes(q) || title.toLowerCase().includes(q);
}

/**
 * The map-side view of a search: the set of matching docIds, or null for an
 * empty query (= no search active, nothing dimmed). Mirrors Obsidian's graph
 * filter: matches stay lit, the rest dims.
 */
export function searchHits(graph: StandardsGraphData, query: string): Set<string> | null {
  if (!query.trim()) return null;
  const hits = new Set<string>();
  for (const n of graph.nodes) {
    if (matchesQuery(query, n.handle, n.title)) hits.add(n.docId);
  }
  return hits;
}

/** The hovered node plus everything one link away (either edge kind). */
export function neighborhoodOf(nodeId: string, links: SimLink[]): Set<string> {
  const set = new Set([nodeId]);
  for (const l of links) {
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    if (s === nodeId) set.add(t);
    if (t === nodeId) set.add(s);
  }
  return set;
}

// ── Local-graph focus (spec-496 dec-5) ───────────────────────────────────────

export type FocusDepth = 1 | 2;

/**
 * The focused node's n-hop neighborhood over ALL edges (mention + semantic):
 * depth 1 = the node and its direct neighbours, depth 2 = one hop further.
 * The focus UI's depth chip switches between exactly these two sets (ac-14).
 */
export function focusSetOf(nodeId: string, depth: FocusDepth, links: SimLink[]): Set<string> {
  let frontier = new Set([nodeId]);
  const seen = new Set([nodeId]);
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const nb of neighborhoodOf(id, links)) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.add(nb);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// ── Directional flow (spec-496 dec-4) ────────────────────────────────────────

/**
 * Which mention edges carry the citing→cited direction indication: exactly
 * those whose BOTH endpoints sit inside the current emphasis set (hover
 * neighborhood or focus subgraph). Null emphasis = calm map, no flow (ac-13).
 * Semantic edges never flow — similarity has no direction.
 */
export function flowEdgeIds(emphasis: Set<string> | null, links: SimLink[]): Set<string> {
  const flowing = new Set<string>();
  if (!emphasis) return flowing;
  for (const l of links) {
    if (l.kind !== 'mention') continue;
    const s = typeof l.source === 'string' ? l.source : l.source.id;
    const t = typeof l.target === 'string' ? l.target : l.target.id;
    if (emphasis.has(s) && emphasis.has(t)) flowing.add(l.id);
  }
  return flowing;
}

// ── Easing math (spec-496 dec-3) ─────────────────────────────────────────────

/** Per-frame lerp fraction — the one motion constant (exponential ease-out). */
export const EASE_RATE = 0.15;
/** Below this distance an eased value snaps to target and counts as settled. */
export const EASE_EPSILON = 0.005;

/**
 * One easing step toward target. Snaps when within EASE_EPSILON so eased
 * values genuinely arrive (letting the ticker sleep) instead of asymptoting.
 * rate=1 collapses to instant — the reduced-motion path uses exactly that.
 */
export function easeToward(current: number, target: number, rate: number = EASE_RATE): number {
  const next = current + (target - current) * rate;
  return Math.abs(target - next) < EASE_EPSILON ? target : next;
}

/**
 * The ticker-sleep predicate (ac-12): the renderer stops its ticker exactly
 * when every eased value is at target, the simulation is at rest, and no
 * flow animation is visible. Any interaction re-wakes it.
 */
export function tickerShouldSleep(
  easedSettled: boolean,
  simActive: boolean,
  flowVisible: boolean,
): boolean {
  return easedSettled && !simActive && !flowVisible;
}

/** Linear RGB mix of two 0xRRGGBB colours — edge strokes easing to accent. */
export function mixColor(a: number, b: number, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * clamped) << 16) |
    (Math.round(ag + (bg - ag) * clamped) << 8) |
    Math.round(ab + (bb - ab) * clamped)
  );
}

// ── Map palette ───────────────────────────────────────────────────────────────
// PIXI composes colors as numbers, so these are literal hexes (same reasoning
// as CHART_PALETTES: CSS-var strings can't be composed in JS). Nodes and
// mention edges sit in the neutral slate family — Obsidian-style restraint —
// while hover highlights and the semantic overlay take the shared chart
// accent (violet) so "fuzzy" reads consistently across Insights and the map.
// Cluster hues (spec-496 dec-2) are the std-27 series hues — derived from
// CHART_PALETTES so the map can never drift from the shared palette; violet
// (accent) and rose (failure-only) are deliberately absent.

const hex = (s: string): number => parseInt(s.slice(1), 16);

export interface MapPalette {
  node: number;
  nodeHover: number;
  label: number;
  /** Label card fill + hairline border (hover/focus label emphasis). */
  card: number;
  cardEdge: number;
  mention: number;
  semantic: number;
  /** Alpha applied to everything outside the hovered neighborhood. */
  dimAlpha: number;
  /** Cluster fills (spec-496 dec-2) — std-27 series hues, accent excluded. */
  clusterHues: number[];
  /** Alpha for everything outside the focus subgraph (near-invisible). */
  focusFadeAlpha: number;
}

/** The std-27 series hues a theme offers clusters: amber, blue, cyan, emerald. */
function clusterHuesFor(theme: 'dark' | 'light'): number[] {
  const p = CHART_PALETTES[theme].phase;
  return [p.specify, p.build, p.verify, p.done].map(hex);
}

export const MAP_PALETTES: Record<'dark' | 'light', MapPalette> = {
  dark: {
    node: hex('#94a3b8'), // slate-400
    nodeHover: hex(CHART_PALETTES.dark.accent),
    label: hex('#cbd5e1'), // slate-300 — legible on the card fill
    card: hex('#1e293b'), // slate-800
    cardEdge: hex('#3e4451'),
    mention: hex('#64748b'), // slate-500
    semantic: hex(CHART_PALETTES.dark.accent),
    dimAlpha: 0.15,
    clusterHues: clusterHuesFor('dark'),
    focusFadeAlpha: 0.04,
  },
  light: {
    node: hex('#64748b'), // slate-500
    nodeHover: hex(CHART_PALETTES.light.accent),
    label: hex('#334155'), // slate-700
    card: hex('#ffffff'),
    cardEdge: hex('#e2e8f0'), // slate-200
    mention: hex('#94a3b8'), // slate-400
    semantic: hex(CHART_PALETTES.light.accent),
    dimAlpha: 0.15,
    clusterHues: clusterHuesFor('light'),
    focusFadeAlpha: 0.04,
  },
};
