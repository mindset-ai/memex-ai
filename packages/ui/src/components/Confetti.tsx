import { useEffect, useRef } from 'react';

interface ConfettiProps {
  /** Total firing duration in ms. Particles keep falling for a bit after new spawns stop. */
  durationMs?: number;
  /** Number of particles spawned in the initial burst. */
  particleCount?: number;
}

// Tiny hand-rolled canvas confetti. No external dependency. Spawns a burst of rotating
// rectangles that fall under gravity with slight horizontal drift. Fades out toward the end.
export function Confetti({ durationMs = 3500, particleCount = 180 }: ConfettiProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    // Warm, high-contrast palette that reads on both dark + light themes.
    const colors = ['#f97316', '#eab308', '#10b981', '#3b82f6', '#a855f7', '#ec4899'];

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      color: string;
      size: number;
      angle: number;
      spin: number;
    }
    const particles: Particle[] = [];
    for (let i = 0; i < particleCount; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: -Math.random() * canvas.height * 0.3 - 20,
        vx: (Math.random() - 0.5) * 3,
        vy: Math.random() * 3 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: Math.random() * 7 + 4,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.25,
      });
    }

    let rafId = 0;
    const startedAt = Date.now();

    const tick = () => {
      if (!ctx) return;
      const elapsed = Date.now() - startedAt;
      const fadeStart = durationMs - 800;
      const opacity =
        elapsed < fadeStart ? 1 : Math.max(0, 1 - (elapsed - fadeStart) / 800);

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = opacity;

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.05; // gravity
        p.angle += p.spin;
        if (p.y > canvas.height + 40) {
          // Respawn at the top while we're still in the active phase.
          if (elapsed < fadeStart) {
            p.y = -20;
            p.x = Math.random() * canvas.width;
            p.vy = Math.random() * 3 + 2;
          }
          continue;
        }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }

      if (elapsed < durationMs) {
        rafId = requestAnimationFrame(tick);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, [durationMs, particleCount]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-50"
      aria-hidden
    />
  );
}
