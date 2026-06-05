import { useChat } from '../ChatContext';
import { Badge } from '../ui';

/**
 * Renders a tappable Task card in the chat. \`id\` is whatever the agent emitted
 * into the MDX widget — the seq-style handles \`t-N\` / \`T-N\` are preferred.
 * The fallback Badge intentionally never shows a UUID: per the canonical-ref
 * work (T-1/T-6), UUIDs are no longer addressable from chat, so if one slipped
 * through we render a neutral "task" label rather than leaking it as text.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ChatTaskCard({ id }: { id: string }) {
  const { doc } = useChat();

  const seqMatch = id.match(/^(?:t|T)-(\d+)$/i);
  const seq = seqMatch ? parseInt(seqMatch[1]) : null;

  const task = doc?.tasks?.find((t) =>
    seq !== null ? t.seq === seq : t.id === id
  );

  if (!task) {
    const label = UUID_RE.test(id) ? 'task' : id;
    return <Badge status="archived" label={label} />;
  }

  const handleClick = () => {
    document.getElementById('tasks-panel')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <button
      onClick={handleClick}
      className="my-2 w-full text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer bg-overlay border-edge-subtle hover:border-edge"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted font-mono">T-{task.seq}</span>
        <Badge status={task.status} />
        {task.blocked && <Badge status="blocked" />}
      </div>
      <div className="text-sm mt-1 text-primary">{task.title}</div>
    </button>
  );
}
