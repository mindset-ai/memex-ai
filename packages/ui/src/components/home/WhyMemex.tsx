// spec-305 — "Why Memex?", the interactive answer. Clicking it blooms three nodes out
// of a central Memex node, the three pains that broke vibe-coding for us (the origin
// story). Click each to learn it; when all three are explored the centre lights up and
// the synthesis lands. The interaction IS the product: Memex is nodes and edges, so we
// explain it with its own data model. Garnish, not a gate — Get started is always there.
import { useState } from 'react';

interface PainNode {
  id: string;
  label: string;
  body: string;
  // Position as % within the graph box (the centre Memex node sits at 50/50).
  x: number;
  y: number;
}

const NODES: ReadonlyArray<PainNode> = [
  {
    id: 'docs',
    label: 'Docs that rot',
    body: "The markdown you write is right the day you write it, and quietly wrong a week later — a heap of files with no way to tell which still hold. In Memex the spec isn't a doc that rots: the tests hold it to account, so it stays honest.",
    x: 15,
    y: 20,
  },
  {
    id: 'drift',
    label: "Drift you can't see",
    body: 'CI checks the code works. Nothing checks it makes sense, so it drifts back toward generic example code, one prompt at a time. Memex flags the drift the moment your code diverges from the standards you set.',
    x: 85,
    y: 20,
  },
  {
    id: 'trust',
    label: "Can't trust what shipped",
    body: "It looked right. It compiled. It passed the tests. And none of that told you it did what you'd actually decided. Memex binds every promise to a test, so “is it right” is a question you can answer instead of feel.",
    x: 50,
    y: 88,
  },
];

const SYNTHESIS =
  'That’s Memex: the plan, the decisions, and the proof in one living graph. The speed of AI coding, without the three risks that come with it.';

export function WhyMemex({ onNavigate }: { onNavigate: (stepId: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const allVisited = visited.size === NODES.length;
  const selectedNode = NODES.find((n) => n.id === selected) ?? null;

  function pick(id: string) {
    setSelected(id);
    setVisited((v) => new Set(v).add(id));
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-why-memex"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        <h1 className="text-3xl font-black tracking-tight text-heading sm:text-4xl">Why Memex?</h1>
        <p className="mt-3 text-secondary">
          We built it for ourselves. For a year we tried to make vibe-coding work, and every version broke on the
          same three things. Click one.
        </p>

        {/* The graph: a centre Memex node + three pains, edges behind. */}
        <div className="relative mt-6 h-[260px] select-none">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
            {NODES.map((n) => {
              const lit = visited.has(n.id) || selected === n.id;
              return (
                <line
                  key={n.id}
                  x1="50"
                  y1="50"
                  x2={n.x}
                  y2={n.y}
                  className={lit ? 'stroke-accent' : 'stroke-edge'}
                  strokeWidth={lit ? 0.7 : 0.4}
                  strokeOpacity={lit ? 0.9 : 0.5}
                />
              );
            })}
          </svg>

          {/* Centre Memex node */}
          <div
            data-testid="why-memex-centre"
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full px-5 py-3 text-sm font-bold text-white transition-all ${
              allVisited
                ? 'bg-[linear-gradient(96deg,#fb5b78,#c084fc)] shadow-[0_0_30px_rgba(192,132,252,0.55)] ring-2 ring-accent'
                : 'bg-[linear-gradient(96deg,#8b5cf6,#6366f1)] shadow-lg'
            }`}
          >
            Memex
          </div>

          {/* Pain nodes */}
          {NODES.map((n) => {
            const isSel = selected === n.id;
            const seen = visited.has(n.id);
            return (
              <button
                key={n.id}
                type="button"
                data-testid={`why-node-${n.id}`}
                onClick={() => pick(n.id)}
                style={{ left: `${n.x}%`, top: `${n.y}%` }}
                className={`absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border px-3.5 py-2 text-sm font-medium transition ${
                  isSel
                    ? 'border-accent bg-accent/15 text-accent'
                    : seen
                      ? 'border-edge bg-card-hover text-secondary'
                      : 'border-edge bg-card text-primary hover:border-accent hover:text-accent'
                }`}
              >
                {n.label}
              </button>
            );
          })}
        </div>

        {/* Explanation panel — slides in beside the graph (below it on this width). */}
        <div
          data-testid="why-memex-panel"
          className="mt-4 min-h-[88px] rounded-2xl border border-edge bg-card/60 p-5"
        >
          {selectedNode ? (
            <p className="leading-relaxed text-secondary">{selectedNode.body}</p>
          ) : (
            <p className="leading-relaxed text-muted">
              Three problems that every parallel, AI-assisted team eventually hits. Tap a node.
            </p>
          )}
          {allVisited && (
            <p data-testid="why-memex-synthesis" className="mt-3 font-semibold text-heading">
              {SYNTHESIS}
            </p>
          )}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="why-memex-start"
            onClick={() => onNavigate('identity')}
            className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(96deg,#8b5cf6,#6366f1)] px-5 py-3 text-sm font-bold text-white shadow-lg transition hover:brightness-110"
          >
            Get started
            <span aria-hidden>→</span>
          </button>
          <button
            type="button"
            data-testid="why-memex-back"
            onClick={() => onNavigate('welcome')}
            className="rounded-xl border border-edge px-4 py-3 text-sm font-semibold text-secondary transition hover:bg-card-hover hover:text-primary"
          >
            Back
          </button>
        </div>
      </article>
    </div>
  );
}
