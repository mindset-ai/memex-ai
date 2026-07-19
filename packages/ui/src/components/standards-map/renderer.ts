// spec-179 (t-8): the WebGL engine for the standards network map — PIXI.js
// draws, d3-force lays out. This is Obsidian's graph-view recipe (per amended
// dec-1): a live force simulation where clusters emerge from connectivity,
// hover highlights a node's neighborhood and dims the rest, labels fade in
// with zoom, and dragging a node re-heats the physics.
//
// spec-496 layers on the motion system: one ticker owns every eased value
// (dec-3), hover tints neighborhood edges toward the accent and glows the
// node (ac-2), mention edges flow citing→cited inside the emphasis (dec-4),
// and single-click enters local-graph focus instead of navigating (dec-5).
// The ticker sleeps when eased values settle, the sim rests, and no flow is
// lit (ac-12); reduced motion collapses every transition to instant and
// disables settle/idle/flow.
//
// Everything here is imperative and browser-only (WebGL); the React shell
// (StandardsMap.tsx) owns data fetching and the DOM overlays (semantic
// toggle, evidence panel, focus card) and drives this class through its
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
  easeToward,
  flowEdgeIds,
  focusSetOf,
  labelAlphaForZoom,
  mixColor,
  neighborhoodOf,
  nodeColor,
  tickerShouldSleep,
  type FocusDepth,
  type MapPalette,
  type SimGraph,
  type SimLink,
  type SimNode,
} from './model';

export interface RendererCallbacks {
  /** Single click (dec-5): request focus — the shell owns the focus state. */
  onNodeFocus(node: SimNode): void;
  /** Double click: navigate to the standard (the spec-179 deep link). */
  onNodeNavigate(node: SimNode): void;
  onEdgeClick(link: SimLink): void;
  /** Clean background click — the shell clears focus. */
  onBackgroundClick(): void;
}

export interface RendererOptions {
  /** prefers-reduced-motion — settle/idle/flow off, transitions instant. */
  reducedMotion: boolean;
  /**
   * spec-498: flip the flow model. When true, the ONLY edges that animate are
   * those flagged `flow` (the Brain's drift edges), and they flow CONTINUOUSLY
   * regardless of focus/hover; the default directional-flow-within-emphasis
   * (StandardsMap) is suppressed. When false/absent, the default applies.
   */
  continuousFlow?: boolean;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
// spec-498 dec-7: the ceiling the discipline selector zooms to when it frames a
// focus neighbourhood — kept well under MAX_ZOOM so a lone node (no neighbours)
// glides to a comfortable close-up instead of slamming to full zoom.
const FOCUS_MAX_ZOOM = 2.2;
/** Pointer movement (px) below which a node pointerup counts as a click. */
const CLICK_SLOP = 4;
/** Two clean clicks within this window = double-click = navigate. */
const DOUBLE_CLICK_MS = 280;
/** Half-width of the invisible hit corridor around an edge line. */
const EDGE_HIT_PAD = 6;
/** The idle-drift simmer (dec-3): sub-pixel breathing, visible tab only. */
const IDLE_ALPHA_TARGET = 0.003;
/** World-units the on-screen settle perturbs each pre-settled position. */
const SETTLE_JITTER = 7;
/** Flow-dash speed in world-units per ~60fps frame. */
const FLOW_SPEED = 0.35;
const DASH = 6;
const GAP = 4;

interface NodeView {
  root: Container;
  /** Soft radial glow behind the circle — alpha eased by hover/focus. */
  glow: Graphics;
  circle: Graphics;
  labelGroup: Container;
  card: Graphics;
  text: Text;
}

/** Eased visual state — every animated scalar is a (current, target) pair. */
interface NodeAnim {
  alpha: number;
  alphaTarget: number;
  glow: number;
  glowTarget: number;
  card: number;
  cardTarget: number;
}
interface EdgeAnim {
  alpha: number;
  alphaTarget: number;
  /** 0 = calm palette stroke, 1 = full accent emphasis (+flow eligible). */
  emphasis: number;
  emphasisTarget: number;
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
  private nodeAnim = new Map<string, NodeAnim>();
  private edgeAnim = new Map<string, EdgeAnim>();
  private hovered: string | null = null;
  private focused: { id: string; depth: FocusDepth } | null = null;
  /** docIds matching the toolbar search; null = no search active. */
  private searchHits: Set<string> | null = null;
  private flowing = new Set<string>();
  private flowPhase = 0;
  private camera = { scale: 1, scaleTarget: 1, x: 0, y: 0, xTarget: 0, yTarget: 0 };
  private simActive = false;
  private dragging = false;
  private pendingClick: { nodeId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private hasAutoFitted = false;
  private destroyed = false;
  private onWheel: ((e: WheelEvent) => void) | null = null;
  private onVisibility: (() => void) | null = null;

  constructor(
    private palette: MapPalette,
    private callbacks: RendererCallbacks,
    private options: RendererOptions = { reducedMotion: false },
  ) {}

  /** One easing step — instant under reduced motion (dec-3). */
  private ease(current: number, target: number): number {
    return this.options.reducedMotion ? target : easeToward(current, target);
  }

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

    // One ticker owns all motion (dec-3). It sleeps at rest (ac-12) — wake()
    // restarts it on any state change; a stopped ticker also stops rendering,
    // so an idle map costs nothing per frame.
    app.ticker.add(() => this.update());
    app.renderer.on('resize', () => this.wake());

    // No burn on a hidden tab: pause outright, resume on return.
    this.onVisibility = () => {
      if (document.visibilityState === 'hidden') this.app?.ticker.stop();
      else this.wake();
    };
    document.addEventListener('visibilitychange', this.onVisibility);

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
    if (this.focused && !this.nodes.some((n) => n.id === this.focused!.id)) {
      this.focused = null;
    }
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
        .force('collide', forceCollide<SimNode>((d) => d.radius + 34));
      // The sim never runs on d3's internal timer — the ticker steps it, so
      // there is exactly one loop to sleep (ac-12).
      this.sim.stop();
      // Settle the layout synchronously before the first paint, then fit the
      // camera once. Cheap at standards scale (tens of nodes), and it means
      // the map appears already composed — no end-of-animation camera jump.
      this.sim.tick(240);
      this.autoFit();
      if (!this.options.reducedMotion) {
        // The on-screen settle (dec-3): jitter the settled positions a touch
        // and let a short low-alpha replay breathe the map into place — the
        // camera never moves, so spec-179's no-jump guarantee holds. The sim
        // then simmers at IDLE_ALPHA_TARGET for the permanent subtle drift.
        for (const n of this.nodes) {
          n.x = (n.x ?? 0) + (this.jitter(n.id) - 0.5) * 2 * SETTLE_JITTER;
          n.y = (n.y ?? 0) + (this.jitter(n.id + 'y') - 0.5) * 2 * SETTLE_JITTER;
        }
        this.sim.alpha(0.25).alphaTarget(IDLE_ALPHA_TARGET).alphaMin(0.001);
        this.simActive = true;
      }
    } else {
      this.sim.nodes(this.nodes);
      (this.sim.force('link') as ForceLink<SimNode, SimLink>).links(this.links);
      if (this.options.reducedMotion) {
        this.sim.tick(120); // settle instantly — no on-screen physics
      } else {
        this.sim.alpha(0.5).alphaTarget(IDLE_ALPHA_TARGET);
        this.simActive = true;
      }
    }
    this.applyHighlight();
    this.draw();
    this.wake();
  }

  /** Search results from the toolbar — hits stay lit (accent), rest dims. */
  setSearch(hits: Set<string> | null): void {
    this.searchHits = hits;
    this.applyHighlight();
  }

  /**
   * Local-graph focus (dec-5). The shell owns the state; passing null exits.
   * The focus subgraph stays lit, everything else fades to near-invisible.
   */
  setFocus(nodeId: string | null, depth: FocusDepth = 1): void {
    this.focused = nodeId ? { id: nodeId, depth } : null;
    this.applyHighlight();
  }

  /**
   * Glide the camera to FRAME a node and its focus neighbourhood — the discipline
   * selector's "zoom into the focused view" (spec-498 dec-7). Computes the bounding
   * box of the focus set (the node + everything within `depth` hops, via the same
   * focusSetOf the highlight uses) and eases the camera to fit it, so selecting a
   * discipline zooms IN and reveals its related nodes in one motion. Rides the
   * existing eased camera targets (the same glide as wheel zoom); instant under
   * reduced motion. Never zooms OUT below reading zoom (1×) — labels stay legible.
   */
  frameFocus(nodeId: string, depth: FocusDepth = 1): void {
    if (!this.app) return;
    const ids = focusSetOf(nodeId, depth, this.links);
    const framed = this.nodes.filter((n) => ids.has(n.id));
    if (framed.length === 0) return;

    const PAD = 90; // world-units margin so labels around the set stay on-screen
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of framed) {
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
    // Zoom toward the focus box, but clamp to [reading zoom, FOCUS_MAX_ZOOM] so a
    // large neighbourhood never zooms out past 1× and a lone node never over-zooms.
    const fit = Math.min(width / (maxX - minX), height / (maxY - minY));
    const scale = Math.max(1, Math.min(FOCUS_MAX_ZOOM, fit));
    const cam = this.camera;
    cam.scaleTarget = scale;
    cam.xTarget = width / 2 - ((minX + maxX) / 2) * scale;
    cam.yTarget = height / 2 - ((minY + maxY) / 2) * scale;
    this.wake();
  }

  setPalette(palette: MapPalette): void {
    this.palette = palette;
    // Labels bake the palette into their fills — rebuild the scene
    // (positions live on the sim nodes, so nothing moves).
    this.buildViews();
    this.applyHighlight();
    this.draw();
    this.wake();
  }

  // ── e2e observation surface (spec-496 t-5) ──────────────────────────────
  // WebGL nodes have no DOM: the std-28 journey reads screen positions to
  // click nodes for real and fills to assert cluster colouring. Read-only.

  /** Screen-space centre of a node, by handle — null before layout/mount. */
  nodeScreenPosition(handle: string): { x: number; y: number } | null {
    const node = this.nodes.find((n) => n.handle === handle);
    if (!node || !this.app) return null;
    const cam = this.camera;
    return {
      x: cam.x + (node.x ?? 0) * cam.scale,
      y: cam.y + (node.y ?? 0) * cam.scale,
    };
  }

  /** The base fill (cluster hue or neutral slate) for a node, by handle. */
  nodeFill(handle: string): number | null {
    const node = this.nodes.find((n) => n.handle === handle);
    return node ? nodeColor(node, this.palette) : null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pendingClick) clearTimeout(this.pendingClick.timer);
    this.pendingClick = null;
    this.sim?.stop();
    this.sim = null;
    if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.onWheel && this.app) {
      this.app.canvas.removeEventListener('wheel', this.onWheel);
    }
    this.app?.destroy(true, { children: true });
    this.app = null;
  }

  // ── the one animation loop (dec-3) ──────────────────────────────────────

  private wake(): void {
    if (this.destroyed || !this.app) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!this.app.ticker.started) this.app.ticker.start();
  }

  private update(): void {
    if (!this.app) return;

    // 1. Physics — manual stepping so the ticker is the only loop.
    if (this.sim && this.simActive) {
      this.sim.tick();
      if (this.sim.alpha() < this.sim.alphaMin()) this.simActive = false;
    }

    // 2. Eased values.
    let settled = true;
    for (const a of this.nodeAnim.values()) {
      a.alpha = this.ease(a.alpha, a.alphaTarget);
      a.glow = this.ease(a.glow, a.glowTarget);
      a.card = this.ease(a.card, a.cardTarget);
      if (a.alpha !== a.alphaTarget || a.glow !== a.glowTarget || a.card !== a.cardTarget) {
        settled = false;
      }
    }
    for (const a of this.edgeAnim.values()) {
      a.alpha = this.ease(a.alpha, a.alphaTarget);
      a.emphasis = this.ease(a.emphasis, a.emphasisTarget);
      if (a.alpha !== a.alphaTarget || a.emphasis !== a.emphasisTarget) settled = false;
    }

    // 3. Camera easing (wheel zoom glides toward the cursor anchor).
    const cam = this.camera;
    cam.scale = this.ease(cam.scale, cam.scaleTarget);
    cam.x = this.ease(cam.x, cam.xTarget);
    cam.y = this.ease(cam.y, cam.yTarget);
    if (cam.scale !== cam.scaleTarget || cam.x !== cam.xTarget || cam.y !== cam.yTarget) {
      settled = false;
    }
    this.world.scale.set(cam.scale);
    this.world.position.set(cam.x, cam.y);

    // 4. Flow animation (dec-4) — advances only while emphasis is lit.
    const flowVisible = !this.options.reducedMotion && this.flowing.size > 0;
    if (flowVisible) this.flowPhase = (this.flowPhase + FLOW_SPEED) % (DASH + GAP);

    this.draw();

    // 5. Sleep at rest (ac-12) — any interaction wakes us back up.
    if (tickerShouldSleep(settled, this.simActive, flowVisible) && !this.dragging) {
      this.app.ticker.stop();
    }
  }

  /** Deterministic per-node jitter in [0,1) — no Math.random, stable replay. */
  private jitter(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
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
      if (!this.edgeAnim.has(link.id)) {
        this.edgeAnim.set(link.id, { alpha: 1, alphaTarget: 1, emphasis: 0, emphasisTarget: 0 });
      }
    }
    for (const id of [...this.edgeAnim.keys()]) {
      if (!this.edgeViews.has(id)) this.edgeAnim.delete(id);
    }

    for (const node of this.nodes) {
      const root = new Container();
      const glow = new Graphics();
      glow.eventMode = 'none';
      const circle = new Graphics();
      const { labelGroup, card, text } = this.buildLabel(node);
      root.addChild(glow);
      root.addChild(circle);
      root.addChild(labelGroup);
      root.eventMode = 'static';
      root.cursor = 'pointer';
      this.wireNode(root, node);
      this.nodeLayer.addChild(root);
      this.nodeViews.set(node.id, { root, glow, circle, labelGroup, card, text });
      if (!this.nodeAnim.has(node.id)) {
        this.nodeAnim.set(node.id, {
          alpha: 1,
          alphaTarget: 1,
          glow: 0,
          glowTarget: 0,
          card: 0,
          cardTarget: 0,
        });
      }
    }
    for (const id of [...this.nodeAnim.keys()]) {
      if (!this.nodeViews.has(id)) this.nodeAnim.delete(id);
    }
    this.paintNodes();
    this.updateLabels();
  }

  /**
   * Obsidian-style label: bare floating text under the node at rest — the
   * rounded card backs it only on hover/focus, where legibility over edges
   * matters (Design & UX). Text alpha is zoom-driven; the whole group
   * counter-scales so it holds constant screen size.
   */
  private buildLabel(node: SimNode): { labelGroup: Container; card: Graphics; text: Text } {
    const labelGroup = new Container();
    labelGroup.eventMode = 'none'; // the node's circular hitArea owns interaction
    const text = new Text({
      text: node.label ?? `${node.handle} · ${node.title}`,
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
      .fill({ color: this.palette.card, alpha: 1 })
      .stroke({ width: 1, color: this.palette.cardEdge, alpha: 0.9 });
    card.alpha = 0; // bare at rest — eased in on hover/focus
    text.y = padY;
    labelGroup.addChild(card);
    labelGroup.addChild(text);
    labelGroup.y = node.radius + 6;
    return { labelGroup, card, text };
  }

  private paintNodes(): void {
    for (const node of this.nodes) {
      const view = this.nodeViews.get(node.id);
      if (!view) continue;
      const lit = node.id === this.hovered || this.searchHits?.has(node.id);
      const base = nodeColor(node, this.palette);
      // Colour-overridden nodes (spec-498 dec-1) keep their own hue when lit —
      // the hue IS the information; glow + label carry the emphasis.
      const color = lit && node.color === undefined ? this.palette.nodeHover : base;
      view.circle.clear().circle(0, 0, node.radius).fill(color);
      // The glow (ac-2): two soft rings in the node's own cluster colour;
      // overall strength rides the eased glow level via the Graphics alpha.
      view.glow
        .clear()
        .circle(0, 0, node.radius * 2.4)
        .fill({ color: base, alpha: 0.12 })
        .circle(0, 0, node.radius * 1.6)
        .fill({ color: base, alpha: 0.22 });
      const anim = this.nodeAnim.get(node.id);
      view.glow.alpha = anim?.glow ?? 0;
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
      const anim = this.nodeAnim.get(node.id);
      if (!view || !anim) continue;
      view.root.position.set(node.x ?? 0, node.y ?? 0);
      view.root.alpha = anim.alpha;
      view.glow.alpha = anim.glow;
      view.card.alpha = anim.card * 0.92;
    }
    this.updateLabels();
  }

  private drawEdge(g: Graphics, link: SimLink): void {
    const s = link.source;
    const t = link.target;
    if (typeof s === 'string' || typeof t === 'string') return; // pre-sim
    const x1 = s.x ?? 0;
    const y1 = s.y ?? 0;
    const x2 = t.x ?? 0;
    const y2 = t.y ?? 0;
    const anim = this.edgeAnim.get(link.id);
    const emphasis = anim?.emphasis ?? 0;
    g.alpha = anim?.alpha ?? 1;

    g.clear();
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    if (link.kind === 'semantic') {
      // PIXI has no native dash — draw 6/4 world-unit segments by hand so the
      // overlay stays visually distinct from citation edges (spec-179 ac-13).
      for (let d = 0; d < len; d += DASH + GAP) {
        const end = Math.min(d + DASH, len);
        g.moveTo(x1 + ux * d, y1 + uy * d).lineTo(x1 + ux * end, y1 + uy * end);
      }
      g.stroke({ width: link.width, color: this.palette.semantic, alpha: 0.7 });
      return;
    }

    // Mention edge: stroke eases from the calm palette toward the accent
    // with emphasis (ac-2); inside the emphasis it carries direction (dec-4).
    // Colour-overridden edges (spec-498 dec-1) keep their own hue throughout —
    // emphasis still lifts their alpha below.
    const color =
      link.color !== undefined
        ? link.color
        : mixColor(this.palette.mention, this.palette.nodeHover, emphasis);
    // A flagged (drift) edge flows whenever it's in the flowing set — even calm,
    // with no emphasis; a default map edge only flows once its emphasis lifts.
    const flowing = this.flowing.has(link.id) && (link.flow === true || emphasis > 0.05);

    if (flowing && !this.options.reducedMotion) {
      // Animated dash-flow, phase drifting citing→cited.
      for (let d = -(DASH + GAP) + this.flowPhase; d < len; d += DASH + GAP) {
        const start = Math.max(d, 0);
        const end = Math.min(d + DASH, len);
        if (end <= start) continue;
        g.moveTo(x1 + ux * start, y1 + uy * start).lineTo(x1 + ux * end, y1 + uy * end);
      }
      // A continuously-flowing (drift) edge stays clearly visible when calm; a
      // default map's directional flow only appears lit inside an emphasis.
      const flowAlpha = link.flow ? Math.min(1, 0.75 + 0.25 * emphasis) : 0.45 + 0.55 * emphasis;
      g.stroke({ width: link.width + 0.4, color, alpha: flowAlpha });
    } else {
      g.moveTo(x1, y1).lineTo(x2, y2);
      g.stroke({ width: link.width, color, alpha: 0.45 + 0.35 * emphasis });
      if (flowing && this.options.reducedMotion) {
        // Reduced motion: direction survives as a small static arrowhead.
        const mx = x1 + ux * len * 0.55;
        const my = y1 + uy * len * 0.55;
        const size = 5;
        g.moveTo(mx, my)
          .lineTo(mx - ux * size - uy * (size * 0.6), my - uy * size + ux * (size * 0.6))
          .lineTo(mx - ux * size + uy * (size * 0.6), my - uy * size - ux * (size * 0.6))
          .closePath()
          .fill({ color, alpha: 0.9 });
      }
    }

    // A corridor around the line so thin edges are still clickable.
    const px = -uy * EDGE_HIT_PAD;
    const py = ux * EDGE_HIT_PAD;
    g.hitArea = new Polygon([
      x1 + px, y1 + py,
      x2 + px, y2 + py,
      x2 - px, y2 - py,
      x1 - px, y1 - py,
    ]);
  }

  // ── interaction ─────────────────────────────────────────────────────────

  private wireNode(root: Container, node: SimNode): void {
    let dragging = false;
    let moved = 0;
    let last = { x: 0, y: 0 };

    root.on('pointerdown', (e: FederatedPointerEvent) => {
      e.stopPropagation(); // keep the background pan from also engaging
      dragging = true;
      this.dragging = true;
      moved = 0;
      last = { x: e.global.x, y: e.global.y };
      node.fx = node.x;
      node.fy = node.y;
      this.sim?.alphaTarget(0.3);
      this.simActive = true; // re-heat while dragging
      this.wake();
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
      this.dragging = false;
      node.fx = null;
      node.fy = null;
      this.sim?.alphaTarget(this.options.reducedMotion ? 0 : IDLE_ALPHA_TARGET);
      if (moved < CLICK_SLOP) this.handleNodeClick(node);
      e.stopPropagation();
    };
    root.on('pointerup', release);
    root.on('pointerupoutside', release);

    // Hover = neighborhood highlight + label reveal only; the label already
    // carries the full title, so there is no separate DOM tooltip.
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

  /**
   * Click model (dec-5): a clean click waits one beat — a second clean click
   * inside the window navigates (double-click), otherwise the single click
   * requests focus from the shell.
   */
  private handleNodeClick(node: SimNode): void {
    if (this.pendingClick && this.pendingClick.nodeId === node.id) {
      clearTimeout(this.pendingClick.timer);
      this.pendingClick = null;
      this.callbacks.onNodeNavigate(node);
      return;
    }
    if (this.pendingClick) clearTimeout(this.pendingClick.timer);
    this.pendingClick = {
      nodeId: node.id,
      timer: setTimeout(() => {
        this.pendingClick = null;
        this.callbacks.onNodeFocus(node);
      }, DOUBLE_CLICK_MS),
    };
  }

  private wirePanZoom(): void {
    const app = this.app!;
    let panning = false;
    let panMoved = 0;
    let last = { x: 0, y: 0 };

    app.stage.on('pointerdown', (e: FederatedPointerEvent) => {
      panning = true;
      panMoved = 0;
      last = { x: e.global.x, y: e.global.y };
    });
    app.stage.on('pointermove', (e: FederatedPointerEvent) => {
      if (!panning) return;
      panMoved += Math.hypot(e.global.x - last.x, e.global.y - last.y);
      // Panning is direct manipulation — current and target move together.
      this.camera.x += e.global.x - last.x;
      this.camera.y += e.global.y - last.y;
      this.camera.xTarget = this.camera.x;
      this.camera.yTarget = this.camera.y;
      last = { x: e.global.x, y: e.global.y };
      this.wake();
    });
    app.stage.on('pointerup', () => {
      // A motionless press on empty background clears focus (dec-5).
      if (panning && panMoved < CLICK_SLOP) this.callbacks.onBackgroundClick();
      panning = false;
    });
    app.stage.on('pointerupoutside', () => {
      panning = false;
    });

    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = app.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const cam = this.camera;
      const old = cam.scaleTarget;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, old * Math.exp(-e.deltaY * 0.0015)));
      if (next === old) return;
      // Zoom toward the cursor: keep the world point under it fixed — the
      // anchor is computed on the *target* frame so the eased camera glides
      // to exactly where a hard zoom would have landed (dec-3).
      cam.xTarget = cx - ((cx - cam.xTarget) / old) * next;
      cam.yTarget = cy - ((cy - cam.yTarget) / old) * next;
      cam.scaleTarget = next;
      this.wake();
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
    const cam = this.camera;
    cam.scale = cam.scaleTarget = scale;
    cam.x = cam.xTarget = width / 2 - ((minX + maxX) / 2) * scale;
    cam.y = cam.yTarget = height / 2 - ((minY + maxY) / 2) * scale;
    this.world.scale.set(scale);
    this.world.position.set(cam.x, cam.y);
  }

  // ── highlight targets + labels ──────────────────────────────────────────

  /** The current emphasis set: focus > hover > search > null (calm). */
  private emphasisSet(): Set<string> | null {
    if (this.focused) return focusSetOf(this.focused.id, this.focused.depth, this.links);
    if (this.hovered) return neighborhoodOf(this.hovered, this.links);
    return this.searchHits;
  }

  /**
   * Recompute every animation TARGET from (focused, hovered, search). The
   * ticker eases the current values toward these — nothing snaps (ac-1),
   * except under reduced motion where easing is instant by design.
   */
  private applyHighlight(): void {
    const emphasis = this.emphasisSet();
    const fade = this.focused ? this.palette.focusFadeAlpha : this.palette.dimAlpha;
    const primary = this.focused?.id ?? this.hovered;

    for (const node of this.nodes) {
      const anim = this.nodeAnim.get(node.id);
      if (!anim) continue;
      anim.alphaTarget = !emphasis || emphasis.has(node.id) ? 1 : fade;
      anim.glowTarget = node.id === primary ? 1 : 0;
      anim.cardTarget = node.id === primary || node.id === this.hovered ? 1 : 0;
    }

    const accentEmphasis = this.focused !== null || this.hovered !== null;
    for (const link of this.links) {
      const anim = this.edgeAnim.get(link.id);
      if (!anim) continue;
      const s = typeof link.source === 'string' ? link.source : link.source.id;
      const t = typeof link.target === 'string' ? link.target : link.target.id;
      const lit = this.focused
        ? emphasis!.has(s) && emphasis!.has(t)
        : this.hovered
          ? s === this.hovered || t === this.hovered
          : // Search: an edge stays lit only when it connects two hits.
            !emphasis || (emphasis.has(s) && emphasis.has(t));
      anim.alphaTarget = lit ? 1 : fade;
      anim.emphasisTarget = accentEmphasis && lit ? 1 : 0;
    }

    // spec-498 continuous-flow mode (Brain): the flagged edges (drift) are the
    // only animated lines and they flow ALWAYS — independent of emphasis. The
    // default map shows direction only inside a hover/focus emphasis, on lit edges.
    this.flowing = this.options.continuousFlow
      ? new Set(this.links.filter((l) => l.flow).map((l) => l.id))
      : accentEmphasis
        ? new Set(
            [...flowEdgeIds(emphasis, this.links)].filter(
              (id) => (this.edgeAnim.get(id)?.emphasisTarget ?? 0) > 0,
            ),
          )
        : new Set();

    this.paintNodes();
    this.wake();
  }

  private updateLabels(): void {
    const scale = this.camera.scale;
    const zoomAlpha = labelAlphaForZoom(scale);
    // Counter-scale the labels so they hold a constant *screen* size while
    // the graph zooms underneath them (Obsidian behaviour) — without this
    // they balloon as you zoom in. Floored so far-out labels don't explode
    // in world units while they're still fading away.
    const counter = 1 / Math.max(scale, 0.8);
    const emphasis = this.emphasisSet();
    for (const node of this.nodes) {
      const view = this.nodeViews.get(node.id);
      if (!view) continue;
      // Emphasised labels are always legible, zoom level regardless.
      view.labelGroup.alpha = emphasis?.has(node.id) ? 1 : zoomAlpha;
      view.labelGroup.scale.set(counter);
    }
  }
}
