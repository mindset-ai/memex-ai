// spec-200 t-5: a one-shot, full-screen confetti burst fired when the What's New
// ribbon slides up. Dependency-free (no canvas-confetti) — a fixed, pointer-events
// -none overlay of N CSS-animated pieces that auto-unmounts when the burst ends.
// Honours prefers-reduced-motion (the caller skips rendering it).

import { useEffect, useMemo, useState } from 'react';

const PIECE_COUNT = 80;
const DURATION_MS = 1800;
const COLORS = ['#6e8bff', '#a371f7', '#3fb950', '#f0a35e', '#ff6b9d', '#56d4dd'];

interface Piece {
  left: number; // vw start (clustered at the ribbon, bottom-centre)
  dx: number; // horizontal spread (vw)
  rise: number; // upward travel (vh) — pieces pop UP and out from the ribbon
  rot: number; // final rotation (deg)
  delay: number; // ms
  color: string;
  size: number; // px
  round: boolean;
}

/**
 * Renders the burst once, then calls onDone after the animation so the parent can
 * unmount it. `seed` (e.g. the entry id) varies piece layout between bursts.
 */
export function Confetti({ onDone }: { onDone?: () => void }) {
  const [gone, setGone] = useState(false);

  const pieces = useMemo<Piece[]>(() => {
    return Array.from({ length: PIECE_COUNT }, (_, i) => {
      // eslint-disable-next-line no-restricted-properties
      const r = Math.random;
      return {
        left: 50 + (r() - 0.5) * 8, // tight cluster at the ribbon (bottom-centre)
        dx: (r() - 0.5) * 150, // fan out left/right as they rise
        rise: 45 + r() * 50, // pop UPWARD out of the ribbon
        rot: (r() - 0.5) * 1080,
        delay: r() * 120,
        color: COLORS[i % COLORS.length],
        size: 7 + r() * 8,
        round: r() > 0.5,
      };
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setGone(true);
      onDone?.();
    }, DURATION_MS + 200);
    return () => clearTimeout(t);
  }, [onDone]);

  if (gone) return null;

  return (
    <div
      aria-hidden="true"
      data-testid="whats-new-confetti"
      style={{ position: 'fixed', inset: 0, zIndex: 60, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {/* Pieces launch up + out from the ribbon, arc to a peak, then fall back
          and fade — a party-popper burst originating at the ribbon. */}
      <style>{`
        @keyframes wn-confetti {
          0%   { transform: translate3d(0, 0, 0) rotate(0deg); opacity: 1; }
          15%  { opacity: 1; }
          55%  { transform: translate3d(calc(var(--wn-dx) * .7), calc(var(--wn-rise) * -1), 0) rotate(calc(var(--wn-rot) * .6)); opacity: 1; }
          100% { transform: translate3d(var(--wn-dx), calc(var(--wn-rise) * .2), 0) rotate(var(--wn-rot)); opacity: 0; }
        }
      `}</style>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            bottom: '64px', // the ribbon sits at bottom-6 (~24px) + its height
            left: `${p.left}vw`,
            width: `${p.size}px`,
            height: `${p.size}px`,
            background: p.color,
            borderRadius: p.round ? '50%' : '2px',
            // custom props consumed by the keyframe
            ['--wn-dx' as string]: `${p.dx}vw`,
            ['--wn-rise' as string]: `${p.rise}vh`,
            ['--wn-rot' as string]: `${p.rot}deg`,
            animation: `wn-confetti ${DURATION_MS}ms cubic-bezier(.2,.6,.3,1) ${p.delay}ms forwards`,
          }}
        />
      ))}
    </div>
  );
}
