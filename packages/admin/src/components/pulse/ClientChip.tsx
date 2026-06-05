// ClientChip — one active-client chip in the Pulse header (b-60).
//
// Under the "Just me" scope the page renders one chip per active client the
// current user is driving (e.g. a Claude Code session, the web UI, an MCP
// agent). Each chip carries a LiveDot so you can see at a glance which of your
// own clients is currently producing activity, and clicking it filters the feed
// to that client.
//
// PRESENTATIONAL + a toggle button. `active` drives selected styling; clicking
// always fires `onClick` — the *page* decides what a click means (select this
// client, or clear the filter when an already-active chip is re-clicked). This
// component holds no state and never reads the router.

import { LiveDot } from './LiveDot';

export interface ClientChipProps {
  /** Human-readable client label (e.g. "Claude Code", "Web UI"). */
  label: string;
  /** Whether this client has produced activity recently — drives the LiveDot. */
  live: boolean;
  /** Whether the feed is currently filtered to this client. */
  active: boolean;
  /** Toggle handler. The page selects on click and clears on re-click. */
  onClick: () => void;
}

export function ClientChip({ label, live, active, onClick }: ClientChipProps) {
  return (
    <button
      type="button"
      // aria-pressed communicates the toggle state to assistive tech, matching
      // the visual "active" styling.
      aria-pressed={active}
      onClick={onClick}
      title={
        active
          ? `Filtering to ${label} — click to clear`
          : `Filter activity to ${label}`
      }
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-edge-strong ${
        active
          ? 'border-edge-strong bg-selected text-primary'
          : 'border-edge bg-input text-secondary hover:text-primary hover:bg-overlay'
      }`}
    >
      <LiveDot live={live} size="sm" />
      <span className="truncate max-w-[10rem]">{label}</span>
    </button>
  );
}
