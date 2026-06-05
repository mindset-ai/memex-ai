import type { MemexVisibility } from '../api/client';

// spec-111 t-7: the 🌐 Public badge that sits next to a Memex name in the
// header. Renders ONLY for public memexes — a private memex renders nothing,
// so callers can drop `<MemexPublicBadge visibility={…} />` next to the name
// unconditionally and the badge appears only when relevant.
//
// Kept as a standalone component (not a variant of ui/Badge) because the
// status-driven ui/Badge keys its colours off a domain status string; the
// public indicator is a fixed affordance with its own globe glyph.
export function MemexPublicBadge({
  visibility,
  className = '',
}: {
  visibility: MemexVisibility | null | undefined;
  className?: string;
}) {
  if (visibility !== 'public') return null;
  return (
    <span
      data-testid="memex-public-badge"
      title="This Memex is public — anyone with the link can read it"
      className={`inline-flex items-center gap-1 rounded-full font-medium border px-1.5 py-0.5 text-[11px] leading-none border-edge bg-card text-secondary ${className}`}
    >
      <span aria-hidden="true">🌐</span>
      Public
    </span>
  );
}
