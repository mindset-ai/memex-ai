import type { Doc, DocSection } from '../api/types';

interface DocOutlineProps {
  doc: Doc;
  sections: DocSection[];
  activeSectionId?: string | null;
  commentCounts?: Record<string, number>;
  onSectionClick?: (sectionId: string) => void;
}

export function DocOutline({
  doc: _doc,
  sections,
  activeSectionId,
  commentCounts = {},
  onSectionClick,
}: DocOutlineProps) {
  if (sections.length === 0) return null;

  return (
    <div className="text-xs">
      <div className="uppercase tracking-wider text-muted/70 mb-2 px-2">Segments</div>
      <nav className="border-l border-edge-subtle">
        {sections.map((section, index) => {
          const num = index + 1;
          const title = section.title || capitalize(section.sectionType);
          const isActive = section.id === activeSectionId;
          const comments = commentCounts[section.id] ?? 0;

          return (
            <a
              key={section.id}
              href={`#section-${num}`}
              onClick={(e) => {
                if (onSectionClick) {
                  e.preventDefault();
                  onSectionClick(section.id);
                  document.getElementById(`section-${num}`)?.scrollIntoView({ behavior: 'smooth' });
                }
              }}
              className={`
                flex items-center gap-2 pl-3 pr-2 py-1 -ml-px border-l transition-colors no-underline
                ${isActive
                  ? '!text-primary font-medium border-primary'
                  : '!text-muted hover:!text-secondary border-transparent'
                }
              `}
            >
              <span className="flex-none w-3 text-right font-mono opacity-50">{num}</span>
              <span className="truncate flex-1">{title}</span>
              {comments > 0 && (
                <span className="flex-none text-muted">{comments}</span>
              )}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

function capitalize(s: string): string {
  return s
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
