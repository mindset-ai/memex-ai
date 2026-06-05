import { useChat } from '../ChatContext';

/**
 * Renders a tappable Section link in the chat. \`id\` is whatever the agent
 * emitted into the MDX widget — the seq-style handles \`s-N\` / \`section-N\`
 * are preferred. The unmatched-id fallback intentionally never shows a UUID:
 * per the canonical-ref work (T-1/T-6), UUIDs are no longer addressable from
 * chat, so a raw UUID renders as a neutral "section" label.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ChatSectionLink({ id }: { id: string }) {
  const { doc } = useChat();

  const sections = doc?.sections ? [...doc.sections].sort((a, b) => a.seq - b.seq) : [];

  // Support "s-N", "section-N", and raw UUID formats.
  const seqMatch = id.match(/^(?:s|section)-(\d+)$/i);
  let sectionIndex: number | null = null;
  let section = null;

  if (seqMatch) {
    sectionIndex = parseInt(seqMatch[1]) - 1;
    section = sections[sectionIndex] ?? null;
  } else {
    // Look up by UUID (legacy / fallback).
    sectionIndex = sections.findIndex((s) => s.id === id);
    section = sectionIndex >= 0 ? sections[sectionIndex] : null;
  }

  const sectionNum = sectionIndex !== null && sectionIndex >= 0 ? sectionIndex + 1 : null;
  const slug = sectionNum ? `section-${sectionNum}` : null;

  const handleClick = () => {
    if (slug) {
      document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // Display fallback: prefer the section title; otherwise the seq label
  // (`Section N`); never the raw UUID.
  const display = section
    ? (section.title ?? `Section ${sectionNum}`)
    : UUID_RE.test(id)
      ? 'section'
      : id;

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1 text-sm transition-colors cursor-pointer text-accent hover:text-accent-hover"
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
      {display}
    </button>
  );
}
