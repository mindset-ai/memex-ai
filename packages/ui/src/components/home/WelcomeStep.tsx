// spec-305 — the welcome step (Beat-1 cold open). "Why Memex?" doesn't take over the
// screen; it grows the SAME card in place into a short, informal lesson — the origin
// story, three pains, one resolution — keeping the headers exactly where they are.
import { useState } from 'react';
import { useAuth } from '../AuthContext';

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  const f = name.trim().split(/\s+/)[0];
  return f || null;
}

export function WelcomeStep({ onNavigate }: { onNavigate: (stepId: string) => void }) {
  const { user } = useAuth();
  const [showWhy, setShowWhy] = useState(false);
  const first = firstName(user?.name);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4 py-10">
      <article
        data-testid="journey-step-welcome"
        className="relative w-full max-w-2xl overflow-hidden rounded-3xl border border-edge bg-surface/70 p-8 shadow-2xl backdrop-blur-xl sm:p-12"
      >
        {first && (
          <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
            Hello, <span>{first}</span>.
          </h1>
        )}
        <h1 className="text-4xl font-black leading-[1.08] tracking-tight text-heading sm:text-5xl">
          Welcome to Memex.
          <span className="block">
            Your plan and your build{' '}
            <span className="bg-[linear-gradient(96deg,#fb5b78,#c084fc)] bg-clip-text text-transparent">
              drift apart
            </span>{' '}
            the moment you write them.
          </span>
        </h1>
        <p className="mt-4 max-w-prose leading-relaxed text-secondary">
          Memex keeps intent and code in lockstep: one living source your agent reads, follows, and proves it
          honoured.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="journey-cta-primary"
            onClick={() => onNavigate('identity')}
            className="inline-flex items-center gap-2 rounded-xl bg-[linear-gradient(96deg,#8b5cf6,#6366f1)] px-5 py-3 text-sm font-bold text-white shadow-lg transition hover:brightness-110"
          >
            Get started
            <span aria-hidden>→</span>
          </button>
          <button
            type="button"
            data-testid="journey-cta-secondary"
            aria-expanded={showWhy}
            onClick={() => setShowWhy((v) => !v)}
            className="rounded-xl border border-edge px-4 py-3 text-sm font-semibold text-secondary transition hover:bg-card-hover hover:text-primary"
          >
            {showWhy ? 'Hide' : 'Why Memex?'}
          </button>
        </div>

        {showWhy && (
          <div data-testid="why-memex-lesson" className="mt-8 border-t border-edge pt-7">
            <h2 className="text-2xl font-black tracking-tight text-heading sm:text-3xl">Why Memex?</h2>
            <p className="mt-3 text-sm leading-relaxed text-secondary">
              The short version. For about a year we tried to make vibe-coding work, and every version broke on the
              same three things.
            </p>
            <div className="mt-5 space-y-4">
              <p className="leading-relaxed text-secondary">
                <span className="font-semibold text-heading">The docs rotted.</span> Every markdown file was right
                the day we wrote it and quietly wrong a week later — a heap of them, no way to tell which still
                held.
              </p>
              <p className="leading-relaxed text-secondary">
                <span className="font-semibold text-heading">The architecture drifted.</span> CI checked the code
                ran. Nothing checked it made sense, so it slid back toward generic example code, one prompt at a
                time.
              </p>
              <p className="leading-relaxed text-secondary">
                <span className="font-semibold text-heading">We couldn&apos;t tell if it was right.</span> It
                compiled, it passed the tests, and none of that told us it did what we&apos;d actually decided.
              </p>
            </div>
            <p className="mt-6 leading-relaxed text-primary">
              Memex is what fell out of fixing that for ourselves: the spec stops being a doc that rots and becomes
              something the tests hold to account — so <span className="italic">is it right</span> is a question you
              answer, not feel.
            </p>
          </div>
        )}
      </article>
    </div>
  );
}
