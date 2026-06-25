// spec-305 dec-5 — the developer/designer/PM role triangle. A draggable blob inside
// an equilateral triangle; its position is stored as barycentric weights {dev, design,
// pm} summing to 1. Embodies the belief that specialisation is dead: you place yourself
// anywhere in the blend, not in a single box. Pointer-drag + keyboard-nudge accessible.
import { useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface RoleCoords {
  dev: number;
  design: number;
  pm: number;
}

// The centered "generalist" default — what a user who skips the triangle gets (dec-5).
export const CENTERED_ROLE: RoleCoords = { dev: 1 / 3, design: 1 / 3, pm: 1 / 3 };

// Equilateral triangle vertices in the SVG viewBox. Developer top, Designer
// bottom-left, PM bottom-right. spec-372 issue-2: the triangle is LEFT-ALIGNED so its
// left point (the Design vertex) sits on the same vertical line as the heading/intro copy
// above it — Design vertex at viewBox x=0, and the SVG itself is left-aligned (no mx-auto)
// so its left edge = the content's left edge. The SVG is overflow-visible so the Design
// vertex marker (centred on x=0) isn't clipped; the Design label is start-anchored so it
// reads rightward and never crosses left of the content edge.
const VERT = {
  dev: { x: 93, y: 30 },
  design: { x: 0, y: 190 },
  pm: { x: 186, y: 190 },
} as const;

// spec-372 (t-12, change-set #2 / ac-29) — v3 persona-vertex colours: Develop green,
// Design purple, Product blue (#0482DC, the onboarding accent → ac-2's "Product vertex").
const VERT_COLOR = {
  dev: '#4FB78F',
  design: '#AC59C5',
  pm: '#0482DC',
} as const;

function toPoint(c: RoleCoords): { x: number; y: number } {
  return {
    x: c.dev * VERT.dev.x + c.design * VERT.design.x + c.pm * VERT.pm.x,
    y: c.dev * VERT.dev.y + c.design * VERT.design.y + c.pm * VERT.pm.y,
  };
}

// Cartesian point → barycentric weights, clamped into the triangle (negatives zeroed
// then renormalised, so a drag outside the edges snaps onto the nearest edge/vertex).
function toCoords(px: number, py: number): RoleCoords {
  const { dev: A, design: B, pm: C } = VERT;
  const denom = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
  let wDev = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / denom;
  let wDesign = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / denom;
  let wPm = 1 - wDev - wDesign;
  wDev = Math.max(0, wDev);
  wDesign = Math.max(0, wDesign);
  wPm = Math.max(0, wPm);
  const s = wDev + wDesign + wPm || 1;
  return { dev: wDev / s, design: wDesign / s, pm: wPm / s };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Compass-rose persona phrase (dec-6). Granular across the WHOLE triangle — including
// distinct bands near each tip (lean → strong → all-in) so the label keeps changing as
// you push toward a corner, not just in the middle. No percentages: people don't think
// that way.
export function personaLabel(c: RoleCoords): string {
  const e = [
    { v: c.dev, noun: 'builder', strong: 'Deep in the code', pure: 'All-in builder', eye: "a builder's hands" },
    { v: c.design, noun: 'designer', strong: 'Designer at heart', pure: 'Pure designer', eye: "a designer's eye" },
    { v: c.pm, noun: 'product mind', strong: 'Product-first', pure: 'Product through and through', eye: "a product head" },
  ].sort((a, b) => b.v - a.v);
  const [a, b] = e;
  const third = e[2].v;

  if (a.v - third < 0.1) return 'Full stack generalist'; // balanced across all three (v3: no hyphen)
  if (a.v - b.v < 0.1) return `${cap(a.noun)} / ${cap(b.noun)}`; // two-way hybrid (an edge)
  if (a.v - b.v < 0.24) return `${cap(a.noun)}, with ${b.eye}`; // a clear lead, second leaning in
  if (a.v > 0.85) return a.pure; // pushed into the tip
  if (a.v > 0.6) return a.strong; // strongly one corner
  return cap(a.noun); // a plain lean
}

// spec-336 — the one-line persona description shown beside the title on step 0
// ("About you"). Mirrors personaLabel's banding (generalist / lead-with-second / plain
// lean) so the copy tracks the title as the dot moves.
export function personaDescription(c: RoleCoords): string {
  const e = [
    { v: c.dev, noun: 'building', solo: "You're confident with coding agents and MCP, working straight from your repo." },
    { v: c.design, noun: 'design', solo: "You're comfortable with coding agents, and happiest close to the design." },
    { v: c.pm, noun: 'product', solo: "You'd rather direct agents than write code — we'll keep the terminal light." },
  ].sort((a, b) => b.v - a.v);
  const [a, b] = e;
  const third = e[2].v;
  if (a.v - third < 0.1) return 'You move across the whole stack — at home in the repo and in the app.';
  if (a.v - b.v < 0.24)
    return `You lean ${a.noun} with a strong ${b.noun} streak — confident with coding agents and your repo.`;
  return a.solo;
}

// spec-372 (t-5, change #10) — the "With Memex we promise" copy, keyed to the DOMINANT
// vertex (dev→Builder, design→Designer, pm→Product), verbatim from the v3 design. Shown
// beside the persona on step 0; the head + detail change live as the dot moves.
export interface PersonaPromise {
  head: string;
  detail: string;
}
export function personaPromise(c: RoleCoords): PersonaPromise {
  const e = [
    {
      v: c.dev,
      head: "Your coding agent can't drift off-spec or fake its way to done.",
      detail: 'Every action it takes is anchored to the specification. If the codebase reveals a better approach, the spec is updated.',
    },
    {
      v: c.design,
      head: 'The design you specified is the design that ships.',
      detail: 'What ships is checked against what you specified. Verified, not assumed.',
    },
    {
      v: c.pm,
      head: "Nothing gets built on a decision you haven't made.",
      detail: "The build can't start until you've resolved the gating decisions, and agents report progress into the board as they work — live, not typed up later.",
    },
  ].sort((a, b) => b.v - a.v);
  return { head: e[0].head, detail: e[0].detail };
}

export function RoleTriangle({
  value,
  onChange,
}: {
  value: RoleCoords;
  onChange: (c: RoleCoords) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  // One-time interaction flag: the pulse + "drag me" hint show until the first move,
  // so it's immediately clear the dot is the thing to grab.
  const [touched, setTouched] = useState(false);
  const blob = toPoint(value);

  function pointerToCoords(e: ReactPointerEvent) {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    onChange(toCoords(p.x, p.y));
  }

  // Keyboard nudge: bias a little toward a vertex, then renormalise (a11y).
  function onKeyDown(e: ReactKeyboardEvent) {
    const step = 0.06;
    const bias: Partial<RoleCoords> =
      e.key === 'ArrowUp'
        ? { dev: step }
        : e.key === 'ArrowDown'
          ? { dev: -step }
          : e.key === 'ArrowLeft'
            ? { design: step }
            : e.key === 'ArrowRight'
              ? { pm: step }
              : {};
    if (Object.keys(bias).length === 0) return;
    e.preventDefault();
    setTouched(true);
    const next = {
      dev: Math.max(0, value.dev + (bias.dev ?? 0)),
      design: Math.max(0, value.design + (bias.design ?? 0)),
      pm: Math.max(0, value.pm + (bias.pm ?? 0)),
    };
    const s = next.dev + next.design + next.pm || 1;
    onChange({ dev: next.dev / s, design: next.design / s, pm: next.pm / s });
  }

  return (
    <div className="w-full">
    <svg
      ref={svgRef}
      viewBox="0 0 240 226"
      role="slider"
      aria-label="Place yourself between developer, designer, and product manager"
      aria-valuetext={personaLabel(value)}
      tabIndex={0}
      data-testid="role-triangle"
      className={`block w-full max-w-[22rem] touch-none select-none overflow-visible rounded-2xl focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setDragging(true);
        setTouched(true);
        pointerToCoords(e);
      }}
      onPointerMove={(e) => dragging && pointerToCoords(e)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={onKeyDown}
    >
      {/* spec-372 t-12 — drag-knob gradient + per-vertex glow gradients (v3). */}
      <defs>
        <radialGradient id="roleBlob">
          <stop offset="0%" stopColor="#4aa3e8" />
          <stop offset="100%" stopColor="#0482DC" />
        </radialGradient>
        <clipPath id="roleTriClip">
          <polygon points={`${VERT.dev.x},${VERT.dev.y} ${VERT.design.x},${VERT.design.y} ${VERT.pm.x},${VERT.pm.y}`} />
        </clipPath>
        <radialGradient id="glowDev" cx={VERT.dev.x} cy={VERT.dev.y} r={210} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={VERT_COLOR.dev} stopOpacity={0.2} />
          <stop offset="0.85" stopColor={VERT_COLOR.dev} stopOpacity={0} />
        </radialGradient>
        <radialGradient id="glowDes" cx={VERT.design.x} cy={VERT.design.y} r={210} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={VERT_COLOR.design} stopOpacity={0.2} />
          <stop offset="0.85" stopColor={VERT_COLOR.design} stopOpacity={0} />
        </radialGradient>
        <radialGradient id="glowProd" cx={VERT.pm.x} cy={VERT.pm.y} r={210} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={VERT_COLOR.pm} stopOpacity={0.2} />
          <stop offset="0.85" stopColor={VERT_COLOR.pm} stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* Faint per-vertex glow fill (v3), clipped to the triangle. Colour-on-transparent so it
          tints correctly in light AND dark themes (no opaque base rect). */}
      <g clipPath="url(#roleTriClip)">
        <rect x="0" y="0" width="280" height="226" fill="url(#glowDev)" />
        <rect x="0" y="0" width="280" height="226" fill="url(#glowDes)" />
        <rect x="0" y="0" width="280" height="226" fill="url(#glowProd)" />
      </g>

      <polygon
        points={`${VERT.dev.x},${VERT.dev.y} ${VERT.design.x},${VERT.design.y} ${VERT.pm.x},${VERT.pm.y}`}
        className="fill-none stroke-edge"
        strokeWidth={1.2}
      />

      <text x={VERT.dev.x} y={VERT.dev.y - 14} textAnchor="middle" className="fill-secondary text-[12px] font-semibold">
        Develop
      </text>
      {/* spec-372 issue-2 — start-anchored so the leftmost label reads rightward from the
          left-aligned Design vertex and never clips past the content's left edge. */}
      <text x={VERT.design.x} y={VERT.design.y + 24} textAnchor="start" className="fill-secondary text-[12px] font-semibold">
        Design
      </text>
      <text x={VERT.pm.x} y={VERT.pm.y + 24} textAnchor="middle" className="fill-secondary text-[12px] font-semibold">
        Product
      </text>

      {/* spec-372 t-12 (ac-29 / ac-2) — coloured vertex markers: outer faint disc + inner
          solid dot with a white ring, one per persona vertex (Product = #0482DC). */}
      {(['dev', 'design', 'pm'] as const).map((k) => (
        <g key={k} data-testid={`role-vertex-${k}`} data-color={VERT_COLOR[k]}>
          <circle cx={VERT[k].x} cy={VERT[k].y} r={8} fill={VERT_COLOR[k]} opacity={0.14} />
          <circle cx={VERT[k].x} cy={VERT[k].y} r={4.5} fill={VERT_COLOR[k]} stroke="#fff" strokeWidth={1.5} />
        </g>
      ))}

      {/* Until first interaction: a soft pulse so the dot reads as grabbable. The "drag" hint
          now lives as a persistent line below the triangle (v3). */}
      {!touched && (
        <circle cx={blob.x} cy={blob.y} r={20} fill="#0482DC" fillOpacity={0.18} className="animate-pulse" />
      )}

      {/* The grabbable knob: a gradient dot with a white ring (the handle). */}
      <circle
        data-testid="role-triangle-blob"
        cx={blob.x}
        cy={blob.y}
        r={16}
        className="fill-[url(#roleBlob)] stroke-white"
        strokeWidth={3}
      />
    </svg>
      {/* spec-372 t-12 — persistent v3 "drag the dot" hint below the triangle. */}
      <div
        data-testid="role-triangle-hint"
        className="mt-3 flex items-center justify-center gap-2 text-[13px] font-semibold text-muted"
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
        Drag the dot to where you fit.
      </div>
    </div>
  );
}
