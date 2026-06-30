// spec-423 (dec-7) — facet pills for a task / decision. The cast ballot's true facet
// keys, rendered as small chips so users meet no new concept (the same pill treatment
// as CommentTypePill). Renders nothing when the work governs no facet.

interface FacetPillsProps {
  facetKeys: string[] | undefined | null;
  className?: string;
}

export function FacetPills({ facetKeys, className = '' }: FacetPillsProps) {
  if (!facetKeys || facetKeys.length === 0) return null;
  return (
    <div data-testid="facet-pills" className={`flex flex-wrap gap-1 ${className}`}>
      {facetKeys.map((key) => (
        <span
          key={key}
          data-testid="facet-pill"
          data-facet-key={key}
          className="inline-flex items-center rounded-full bg-overlay px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted"
        >
          {key}
        </span>
      ))}
    </div>
  );
}
