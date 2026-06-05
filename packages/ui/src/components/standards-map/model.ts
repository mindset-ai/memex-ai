// spec-179 (t-8): the pure model for the standards network map — the data
// shapes d3-force simulates and PIXI renders, plus the interaction math
// (label fade, hover neighborhood). Deliberately free of pixi.js / d3-force
// imports: jsdom tests own this mapping while the WebGL renderer stays
// browser-only (same testing posture as the React Flow mapper this replaces —
// see amended dec-1).

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

  const nodes: SimNode[] = graph.nodes.map((n) => {
    const d = degree.get(n.docId) ?? 0;
    return {
      id: n.docId,
      handle: n.handle,
      title: n.title,
      clauseCount: n.clauseCount,
      degree: d,
      radius: nodeRadius(d),
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
 * Label opacity for a world zoom level — the Obsidian fade-in: label cards
 * are fully present at the initial fit (capped at 1×) and only fade away as
 * you zoom OUT toward the constellation view. The renderer counter-scales
 * the cards so they hold a constant screen size instead of ballooning with
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

// ── Map palette ───────────────────────────────────────────────────────────────
// PIXI composes colors as numbers, so these are literal hexes (same reasoning
// as CHART_PALETTES: CSS-var strings can't be composed in JS). Nodes and
// mention edges sit in the neutral slate family — Obsidian-style restraint —
// while hover highlights and the semantic overlay take the shared chart
// accent (violet) so "fuzzy" reads consistently across Insights and the map.

const hex = (s: string): number => parseInt(s.slice(1), 16);

export interface MapPalette {
  node: number;
  nodeHover: number;
  label: number;
  /** Label card fill + hairline border (wrapped-text cards under nodes). */
  card: number;
  cardEdge: number;
  mention: number;
  semantic: number;
  /** Alpha applied to everything outside the hovered neighborhood. */
  dimAlpha: number;
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
  },
};
