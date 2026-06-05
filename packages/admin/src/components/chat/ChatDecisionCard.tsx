import { useChat } from '../ChatContext';
import { Badge } from '../ui';

/**
 * Renders a tappable Decision card in the chat. \`id\` is whatever the agent
 * emitted into the MDX widget — the seq-style handles \`dec-N\` / \`D-N\` are
 * preferred. The fallback Badge intentionally never shows a UUID: per the
 * canonical-ref work (T-1/T-6), UUIDs are no longer addressable from chat,
 * so if one slipped through we render a neutral "decision" label rather than
 * leaking it as visible text.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ChatDecisionCard({ id }: { id: string }) {
  const { doc } = useChat();

  const seqMatch = id.match(/^(?:dec|D)-(\d+)$/i);
  const seq = seqMatch ? parseInt(seqMatch[1]) : null;

  const decision = doc?.decisions?.find((d) =>
    seq !== null ? d.seq === seq : d.id === id
  );

  if (!decision) {
    // Never surface a raw UUID — fall back to a generic label.
    const label = UUID_RE.test(id) ? 'decision' : id;
    return <Badge status="archived" label={label} />;
  }

  const handleClick = () => {
    document.getElementById('decisions-panel')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <button
      onClick={handleClick}
      className="my-2 w-full text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer bg-overlay border-edge-subtle hover:border-edge"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted font-mono">D-{decision.seq}</span>
        <Badge status={decision.status} />
      </div>
      <div className="text-sm mt-1 text-primary">{decision.title}</div>
      {decision.resolution && (
        <div className="text-xs text-muted mt-1 truncate">{decision.resolution}</div>
      )}
    </button>
  );
}
