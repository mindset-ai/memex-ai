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
// bottom-left, PM bottom-right. The viewBox leaves margin so the vertex labels
// (centered on each corner) never clip.
const VERT = {
  dev: { x: 140, y: 30 },
  design: { x: 47, y: 190 },
  pm: { x: 233, y: 190 },
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

  if (a.v - third < 0.1) return 'Full-stack generalist'; // balanced across all three
  if (a.v - b.v < 0.1) return `${cap(a.noun)} / ${cap(b.noun)}`; // two-way hybrid (an edge)
  if (a.v - b.v < 0.24) return `${cap(a.noun)}, with ${b.eye}`; // a clear lead, second leaning in
  if (a.v > 0.85) return a.pure; // pushed into the tip
  if (a.v > 0.6) return a.strong; // strongly one corner
  return cap(a.noun); // a plain lean
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
    const next = {
      dev: Math.max(0, value.dev + (bias.dev ?? 0)),
      design: Math.max(0, value.design + (bias.design ?? 0)),
      pm: Math.max(0, value.pm + (bias.pm ?? 0)),
    };
    const s = next.dev + next.design + next.pm || 1;
    onChange({ dev: next.dev / s, design: next.design / s, pm: next.pm / s });
  }

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 280 226"
      role="slider"
      aria-label="Place yourself between developer, designer, and product manager"
      aria-valuetext={personaLabel(value)}
      tabIndex={0}
      data-testid="role-triangle"
      className="mx-auto block w-full max-w-[22rem] cursor-pointer touch-none select-none rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setDragging(true);
        pointerToCoords(e);
      }}
      onPointerMove={(e) => dragging && pointerToCoords(e)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={onKeyDown}
    >
      {/* Subtle: a faint fill so the shape reads without dominating the card. */}
      <polygon
        points={`${VERT.dev.x},${VERT.dev.y} ${VERT.design.x},${VERT.design.y} ${VERT.pm.x},${VERT.pm.y}`}
        className="fill-card-hover stroke-edge"
        fillOpacity={0.28}
        strokeWidth={1.25}
      />
      <text x={VERT.dev.x} y={VERT.dev.y - 12} textAnchor="middle" className="fill-secondary text-[12px] font-semibold">
        Developer
      </text>
      <text x={VERT.design.x} y={VERT.design.y + 22} textAnchor="middle" className="fill-secondary text-[12px] font-semibold">
        Designer
      </text>
      <text x={VERT.pm.x} y={VERT.pm.y + 22} textAnchor="middle" className="fill-secondary text-[12px] font-semibold">
        PM
      </text>
      <circle
        data-testid="role-triangle-blob"
        cx={blob.x}
        cy={blob.y}
        r={11}
        className="fill-[url(#roleBlob)] stroke-white"
        strokeWidth={2}
      />
      <defs>
        <radialGradient id="roleBlob">
          <stop offset="0%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </radialGradient>
      </defs>
    </svg>
  );
}
