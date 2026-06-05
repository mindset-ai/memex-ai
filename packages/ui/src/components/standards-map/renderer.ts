// spec-179 (t-8): the WebGL engine for the standards network map — PIXI.js
// draws, d3-force lays out. This is Obsidian's graph-view recipe (per amended
// dec-1): a live force simulation where clusters emerge from connectivity,
// hover highlights a node's neighborhood and dims the rest, labels fade in
// with zoom, and dragging a node re-heats the physics.
//
// Everything here is imperative and browser-only (WebGL); the React shell
// (StandardsMap.tsx) owns data fetching and the DOM overlays (semantic
// toggle, evidence panel, hover card) and drives this class through its
// public methods. jsdom tests cover the pure model (./model.ts), not this.

import {
  Application,
  Container,
  Graphics,
  Polygon,
  Text,
  type FederatedPointerEvent,
} from 'pixi.js';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type ForceLink,
  type Simulation,
} from 'd3-force';
import {
  labelAlphaForZoom,
  neighborhoodOf,
  type MapPalette,
  type SimGraph,
  type SimLink,
  type SimNode,
} from './model';

export interface RendererCallbacks {
  onNodeClick(node: SimNode): void;
  onEdgeClick(link: SimLink): void;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
/** Pointer movement (px) below which a node pointerup counts as a click. */
const CLICK_SLOP = 4;
/** Half-width of the invisible hit corridor around an edge line. */
const EDGE_HIT_PAD = 6;

interface NodeView {
  root: Container;
  circle: Graphics;
  /** The wrapped-text label card under the node (fades with zoom). */
  labelGroup: Container;
}

export class StandardsMapRenderer {
  private app: Application | null = null;
  private world = new Container();
  private edgeLayer = new Container();
  private nodeLayer = new Container();
  private sim: Simulation<SimNode, SimLink> | null = null;
  private nodes: SimNode[] = [];
  private links: SimLink[] = [];
  private nodeViews = new Map<string, NodeView>();
  private edgeViews = new Map<string, Graphics>();
  private hovered: string | null = null;
  /** docIds matching the toolbar search; null = no search active. */
  private searchHits: Set<string> | null = null;
  private hasAutoFitted = false;
  private destroyed = false;
  private onWheel: ((e: WheelEvent) => void) | null = null;

  constructor(
    private palette: MapPalette,
    private callbacks: RendererCallbacks,
  ) {}

  async init(host: HTMLElement, graph: SimGraph): Promise<void> {
    const app = new Application();
    await app.init({
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      resizeTo: host,
    });
    // The async init can lose a race with React unmount — bail cleanly.
    if (this.destroyed) {
      app.destroy(true, { children: true });
      return;
    }
    this.app = app;
    host.appendChild(app.canvas);

    this.world.addChild(this.edgeLayer);
    this.world.addChild(this.nodeLayer);
    app.stage.addChild(this.world);
    app.stage.eventMode = 'static';
    app.stage.hitArea = app.screen;

    this.wirePanZoom();
    this.setGraph(graph);
  }

  /** Swap data (e.g. semantic toggle) — existing nodes keep their positions. */
  setGraph(graph: SimGraph): void {
    if (!this.app) return;
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    for (const n of graph.nodes) {
      const old = prev.get(n.id);
      if (old) {
        n.x = old.x;
        n.y = old.y;
        n.vx = old.vx;
        n.vy = old.vy;
      }
    }
    this.nodes = graph.nodes;
    this.links = graph.links;
    this.hovered = null;
    this.buildViews();

    const { width, height } = this.app.screen;
    if (!this.sim) {
      this.sim = forceSimulation<SimNode, SimLink>(this.nodes)
        .force(
          'link',
          forceLink<SimNode, SimLink>(this.links)
            .id((d) => d.id)
            .distance(190)
            .strength((l) => (l.kind === 'mention' ? 0.4 : 0.05)),
        )
        // Strong repulsion + a generous collide radius (which also shields
        // the label row under each node) keep the layout airy — but the
        // repulsion is range-capped and every node sits in a weak gravity
        // well, so disconnected nodes (no mention edges to tether them)
        // drift to the cluster's edge instead of flying off to infinity.
        .force('charge', forceManyBody().strength(-650).distanceMax(700))
        .force('x', forceX(width / 2).strength(0.06))
        .force('y', forceY(height / 2).strength(0.06))
        .force('collide', forceCollide<SimNode>((d) => d.radius + 34))
        .on('tick', () => this.draw());
      // Settle the layout synchronously before the first paint, then fit the
      // camera once. Cheap at standards scale (tens of nodes), and it means
      // the map appears already composed — no end-of-animation camera jump.
      this.sim.stop();
      this.sim.tick(240);
      this.autoFit();
    } else {
      this.sim.nodes(this.nodes);
      (this.sim.force('link') as ForceLink<SimNode, SimLink>).links(this.links);
      this.sim.alpha(0.5).restart();
    }
    this.draw();
  }

  /** Search results from the toolbar — hits stay lit (accent), rest dims. */
  setSearch(hits: Set<string> | null): void {
    this.searchHits = hits;
    this.applyHighlight();
  }

  setPalette(palette: MapPalette): void {
    this.palette = palette;
    // Label cards bake the palette into their fills — rebuild the scene
    // (positions live on the sim nodes, so nothing moves).
    this.buildViews();
    this.draw();
  }

  destroy(): void {
    this.destroyed = true;
    this.sim?.stop();
    this.sim = null;
    if (this.onWheel && this.app) {
      this.app.canvas.removeEventListener('wheel', this.onWheel);
    }
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  // ── scene construction ──────────────────────────────────────────────────

  private buildViews(): void {
    this.edgeLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.nodeLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.nodeViews.clear();
    this.edgeViews.clear();

    for (const link of this.links) {
      const g = new Graphics();
      if (link.kind === 'mention') {
        // Mention edges carry evidence — clickable.
        g.eventMode = 'static';
        g.cursor = 'pointer';
        g.on('pointertap', () => this.callbacks.onEdgeClick(link));
      } else {
        g.eventMode = 'none';
      }
      this.edgeLayer.addChild(g);
      this.edgeViews.set(link.id, g);
    }

    for (const node of this.nodes) {
      const root = new Container();
      const circle = new Graphics();
      const labelGroup = this.buildLabelCard(node);
      root.addChild(circle);
      root.addChild(labelGroup);
      root.eventMode = 'static';
      root.cursor = 'pointer';
      this.wireNode(root, node);
      this.nodeLayer.addChild(root);
      this.nodeViews.set(node.id, { root, circle, labelGroup });
    }
    this.paintNodes();
    this.updateLabelAlphas();
  }

  /**
   * Obsidian-style label: the full, untruncated `handle · title` wrapped
   * onto a rounded card under the node. The card's *alpha* is zoom-driven
   * (updateLabelAlphas) so the overview reads as bare nodes and the text
   * surfaces as you zoom in.
   */
  private buildLabelCard(node: SimNode): Container {
    const group = new Container();
    group.eventMode = 'none'; // the node's circular hitArea owns interaction
    const text = new Text({
      text: `${node.handle} · ${node.title}`,
      style: {
        fontSize: 11,
        fill: this.palette.label,
        fontFamily: 'sans-serif',
        wordWrap: true,
        wordWrapWidth: 150,
        align: 'center',
        lineHeight: 14,
        breakWords: true, // long unbroken tokens (paths, slugs) still wrap
      },
      resolution: 2,
    });
    text.anchor.set(0.5, 0);
    const padX = 7;
    const padY = 4;
    const w = text.width + padX * 2;
    const h = text.height + padY * 2;
    const card = new Graphics()
      .roundRect(-w / 2, 0, w, h, 6)
      .fill({ color: this.palette.card, alpha: 0.92 })
      .stroke({ width: 1, color: this.palette.cardEdge, alpha: 0.9 });
    text.y = padY;
    group.addChild(card);
    group.addChild(text);
    group.y = node.radius + 6;
    return group;
  }

  private paintNodes(): void {
    for (const node of this.nodes) {
      const view = this.nodeViews.get(node.id);
      if (!view) continue;
      const lit = node.id === this.hovered || this.searchHits?.has(node.id);
      const color = lit ? this.palette.nodeHover : this.palette.node;
      view.circle.clear().circle(0, 0, node.radius).fill(color);
      view.root.hitArea = { contains: (x, y) => x * x + y * y <= (node.radius + 4) ** 2 };
    }
  }

  // ── drawing ─────────────────────────────────────────────────────────────

  private draw(): void {
    for (const link of this.links) {
      const g = this.edgeViews.get(link.id);
      if (g) this.drawEdge(g, link);
    }
    for (const node of this.nodes) {
      const view = this.nodeViews.get(node.id);
      if (view) view.root.position.set(node.x ?? 0, node.y ?? 0);
    }
  }

  private drawEdge(g: Graphics, link: SimLink): void {
    const s = link.source;
    const t = link.target;
    if (typeof s === 'string' || typeof t === 'string') return; // pre-sim
    const x1 = s.x ?? 0;
    const y1 = s.y ?? 0;
    const x2 = t.x ?? 0;
    const y2 = t.y ?? 0;

    g.clear();
    if (link.kind === 'semantic') {
      // PIXI has no native dash — draw 6/4 world-unit segments by hand so the
      // overlay stays visually distinct from citation edges (ac-13).
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const DASH = 6;
      const GAP = 4;
      for (let d = 0; d < len; d += DASH + GAP) {
        const end = Math.min(d + DASH, len);
        g.moveTo(x1 + ux * d, y1 + uy * d).lineTo(x1 + ux * end, y1 + uy * end);
      }
      g.stroke({ width: link.width, color: this.palette.semantic, alpha: 0.7 });
    } else {
      g.moveTo(x1, y1).lineTo(x2, y2);
      g.stroke({ width: link.width, color: this.palette.mention, alpha: 0.45 });
      // A corridor around the line so thin edges are still clickable.
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * EDGE_HIT_PAD;
      const py = (dx / len) * EDGE_HIT_PAD;
      g.hitArea = new Polygon([
        x1 + px, y1 + py,
        x2 + px, y2 + py,
        x2 - px, y2 - py,
        x1 - px, y1 - py,
      ]);
    }
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private wireNode(root: Container, node: SimNode): void {
    let dragging = false;
    let moved = 0;
    let last = { x: 0, y: 0 };

    root.on('pointerdown', (e: FederatedPointerEvent) => {
      e.stopPropagation(); // keep the background pan from also engaging
      dragging = true;
      moved = 0;
      last = { x: e.global.x, y: e.global.y };
      node.fx = node.x;
      node.fy = node.y;
      this.sim?.alphaTarget(0.3).restart(); // re-heat while dragging
    });
    root.on('globalpointermove', (e: FederatedPointerEvent) => {
      if (!dragging) return;
      moved += Math.hypot(e.global.x - last.x, e.global.y - last.y);
      last = { x: e.global.x, y: e.global.y };
      const world = this.world.toLocal(e.global);
      node.fx = world.x;
      node.fy = world.y;
    });
    const release = (e: FederatedPointerEvent) => {
      if (!dragging) return;
      dragging = false;
      node.fx = null;
      node.fy = null;
      this.sim?.alphaTarget(0);
      if (moved < CLICK_SLOP) this.callbacks.onNodeClick(node);
      e.stopPropagation();
    };
    root.on('pointerup', release);
    root.on('pointerupoutside', release);

    // Hover = neighborhood highlight + label reveal only; the label card
    // already carries the full title, so there is no separate DOM tooltip.
    root.on('pointerover', () => {
      this.hovered = node.id;
      this.applyHighlight();
    });
    root.on('pointerout', () => {
      if (this.hovered !== node.id) return;
      this.hovered = null;
      this.applyHighlight();
    });
  }

  private wirePanZoom(): void {
    const app = this.app!;
    let panning = false;
    let last = { x: 0, y: 0 };

    app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
      panning = true;
      last = { x: e.global.x, y: e.global.y };
    });
    app.stage.on('pointermove', (e: FederatedPointerEvent) => {
      if (!panning) return;
      this.world.position.x += e.global.x - last.x;
      this.world.position.y += e.global.y - last.y;
      last = { x: e.global.x, y: e.global.y };
    });
    const stopPan = () => {
      panning = false;
    };
    app.stage.on('pointerup', stopPan);
    app.stage.on('pointerupoutside', stopPan);

    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = app.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const old = this.world.scale.x;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, old * Math.exp(-e.deltaY * 0.0015)));
      if (next === old) return;
      // Zoom toward the cursor: keep the world point under it fixed.
      this.world.position.x = cx - ((cx - this.world.position.x) / old) * next;
      this.world.position.y = cy - ((cy - this.world.position.y) / old) * next;
      this.world.scale.set(next);
      this.updateLabelAlphas();
    };
    app.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /**
   * Fit the pre-settled layout into the viewport, once, before first paint.
   * Never re-fires after interactions — the camera belongs to the user.
   */
  private autoFit(): void {
    if (this.hasAutoFitted || this.destroyed || !this.app || this.nodes.length === 0) return;
    this.hasAutoFitted = true;

    const PAD = 70; // world-units margin around the bounds (covers labels)
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, (n.x ?? 0) - n.radius);
      minY = Math.min(minY, (n.y ?? 0) - n.radius);
      maxX = Math.max(maxX, (n.x ?? 0) + n.radius);
      maxY = Math.max(maxY, (n.y ?? 0) + n.radius);
    }
    minX -= PAD;
    minY -= PAD;
    maxX += PAD;
    maxY += PAD;

    const { width, height } = this.app.screen;
    const scale = Math.min(
      1, // open at reading zoom — labels are fully present at the fit
      Math.max(MIN_ZOOM, Math.min(width / (maxX - minX), height / (maxY - minY))),
    );
    this.world.scale.set(scale);
    this.world.position.set(
      width / 2 - ((minX + maxX) / 2) * scale,
      height / 2 - ((minY + maxY) / 2) * scale,
    );
    this.updateLabelAlphas();
  }

  // ── highlight + label fade ──────────────────────────────────────────────

  private applyHighlight(): void {
    // Hover takes precedence over an active search — pointing at a node is
    // the more immediate intent. Either yields an emphasis set; null = calm.
    const emphasis = this.hovered
      ? neighborhoodOf(this.hovered, this.links)
      : this.searchHits;
    for (const node of this.nodes) {
      const view = this.nodeViews.get(node.id);
      if (!view) continue;
      view.root.alpha = !emphasis || emphasis.has(node.id) ? 1 : this.palette.dimAlpha;
    }
    for (const link of this.links) {
      const g = this.edgeViews.get(link.id);
      if (!g) continue;
      const s = typeof link.source === 'string' ? link.source : link.source.id;
      const t = typeof link.target === 'string' ? link.target : link.target.id;
      const lit = this.hovered
        ? s === this.hovered || t === this.hovered
        : // Search: an edge stays lit only when it connects two hits.
          !emphasis || (emphasis.has(s) && emphasis.has(t));
      g.alpha = lit ? 1 : this.palette.dimAlpha;
    }
    this.paintNodes();
    this.updateLabelAlphas();
  }

  private updateLabelAlphas(): void {
    const scale = this.world.scale.x;
    const zoomAlpha = labelAlphaForZoom(scale);
    // Counter-scale the cards so they hold a constant *screen* size while
    // the graph zooms underneath them (Obsidian behaviour) — without this
    // they balloon as you zoom in. Floored so far-out cards don't explode
    // in world units while they're still fading away.
    const counter = 1 / Math.max(scale, 0.8);
    const emphasis = this.hovered
      ? neighborhoodOf(this.hovered, this.links)
      : this.searchHits;
    for (const node of this.nodes) {
      const view = this.nodeViews.get(node.id);
      if (!view) continue;
      // Hovered-neighborhood and search-hit labels are always legible,
      // zoom level regardless.
      view.labelGroup.alpha = emphasis?.has(node.id) ? 1 : zoomAlpha;
      view.labelGroup.scale.set(counter);
    }
  }
}
