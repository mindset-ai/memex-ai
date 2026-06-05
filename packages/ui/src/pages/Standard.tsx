import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import {
  fetchDoc,
  fetchDocComments,
  NotFoundError,
} from '../api/client';
import type { Comment, DocSection, DocWithGraph } from '../api/types';
import { Spinner } from '../components/Spinner';
import { Badge } from '../components/ui';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { DecisionLink } from '../components/DecisionLink';
import { rehypeRefLinkifier } from '../components/chat/refLinkifier';
import { tenantPath } from '../utils/tenantUrl';

/**
 * Single-standard view (per dec-17 / dec-18 / dec-28).
 *
 * Renders one standard as scrollable markdown sections, with `[per dec-N]`
 * references inlined as clickable `<DecisionLink>` buttons that navigate to
 * the source decision's parent spec.
 *
 * Drift surfaces in two places:
 *   1. A red dot on any section header that has ≥1 OPEN `commentType='drift'`
 *      comment — the per-section staleness signal from t-13's drift scan.
 *   2. A summary badge in the page header showing the total open drift count
 *      across the standard (mirrors the per-card badge on StandardList).
 *
 * Both update live via `useDocChangeStream(standardId)` — t-13's
 * `flagDrift` → `addComment` → `emitDocChange` chain emits standard
 * `{entity: "comment", action: "created"}` SSE events, so subscribing here
 * triggers a refetch and the indicators flip immediately.
 */
export function Standard() {
  const { id } = useParams<{ id: string }>();
  const [doc, setDoc] = useState<DocWithGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commentsBySection, setCommentsBySection] = useState<
    Record<string, Comment[]>
  >({});

  const applyComments = useCallback(
    (result: Awaited<ReturnType<typeof fetchDocComments>>) => {
      const sMap: Record<string, Comment[]> = {};
      for (const entry of result.sections) {
        sMap[entry.section.id] = entry.comments;
      }
      setCommentsBySection(sMap);
    },
    [],
  );

  const load = useCallback(() => {
    if (!id) return;
    fetchDoc(id)
      .then((d) => {
        setDoc(d);
        fetchDocComments(d.id).then(applyComments).catch(console.error);
      })
      .catch((err) => {
        if (err instanceof NotFoundError) setNotFound(true);
        else setError(err.message);
      })
      .finally(() => setLoading(false));
  }, [id, applyComments]);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates from t-13's drift scan + any other agent/MCP/REST mutations.
  useDocChangeStream(doc?.id ?? null, load);

  // Per-section open-drift counts, used both for the section red dot and the
  // header badge total. Resolved drift comments are explicitly excluded — once
  // a human re-validates the rule, the indicator must clear.
  const driftCountsBySection = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const [sectionId, comments] of Object.entries(commentsBySection)) {
      out[sectionId] = comments.filter(
        (c) => c.commentType === 'drift' && !c.resolvedAt,
      ).length;
    }
    return out;
  }, [commentsBySection]);

  const totalDriftCount = useMemo(
    () => Object.values(driftCountsBySection).reduce((a, b) => a + b, 0),
    [driftCountsBySection],
  );

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link
          to={tenantPath('/standards')}
          className="text-sm text-secondary hover:text-primary mb-8 inline-block"
        >
          &larr; Back to standards
        </Link>
        <div className="text-secondary text-center py-16 border border-edge rounded-lg bg-panel">
          Standard not found
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link
          to={tenantPath('/standards')}
          className="text-sm text-secondary hover:text-primary mb-8 inline-block"
        >
          &larr; Back to standards
        </Link>
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
          Failed to load standard: {error}
        </div>
      </div>
    );
  }

  const sortedSections = [...doc.sections].sort((a, b) => a.seq - b.seq);

  return (
    // spec-130: the Standard view renders bare inside AppShell's
    // `overflow-hidden` <main> (it is not a doc-page route), so without a scroll
    // container here any content past the first viewport is clipped and
    // unreachable. Mirror the single-document reading view (DocumentShell's
    // `h-full overflow-y-auto`) so the whole standard scrolls as one column.
    <div className="h-full overflow-y-auto" data-testid="standard-scroll">
      <div className="px-6 py-4 max-w-4xl">
        {/* Header */}
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <Link
              to={tenantPath('/standards')}
              className="text-xs text-secondary hover:text-primary mb-2 inline-block"
            >
              &larr; Standards
            </Link>
            <h1 className="text-2xl font-bold text-heading">{doc.title}</h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-muted">
              <span className="font-mono">{doc.handle}</span>
              <Badge status={doc.status} />
              <span>{doc.docType}</span>
              {totalDriftCount > 0 && (
                <Link
                  to={`${tenantPath('/drift')}?doc=${doc.handle}`}
                  className="text-xs font-medium px-2 py-0.5 rounded-full bg-status-danger-bg text-status-danger-text border border-status-danger-border hover:opacity-90"
                  data-testid="standard-total-drift-count"
                  title={`${totalDriftCount} open drift comment${totalDriftCount === 1 ? '' : 's'} — view in the Drift Inbox`}
                >
                  {totalDriftCount} drift
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Sections */}
        <div className="space-y-6">
          {sortedSections.map((section, idx) => (
            <StandardSection
              key={section.id}
              section={section}
              sectionNumber={idx + 1}
              driftCount={driftCountsBySection[section.id] ?? 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

interface StandardSectionProps {
  section: DocSection;
  sectionNumber: number;
  driftCount: number;
}

/**
 * Encodes any of the three cite forms as a placeholder HTML tag
 * (`<decisionref handle="…" />`) before passing the content to react-markdown.
 * Combined with `rehype-raw` and a `decisionref` component override, this gives
 * us inline React rendering of the reference without rewriting the entire
 * markdown parser.
 *
 * Three accepted forms (per t-7 / dec-2):
 *   - `[per mis-N:dec-M]` — NEW canonical Spec cite (the `mis-` literal predates the b-105 rename)
 *   - `[per doc-N:dec-M]` — legacy qualified
 *   - `[per dec-M]`       — legacy bare
 *
 * The handle round-trips verbatim into the tag attribute (all three shapes are
 * HTML-safe — only `[A-Za-z0-9:-]`). The downstream `<DecisionLink>` component
 * applies the t-7 display upgrade (legacy `doc-N:dec-M` → canonical `mis-N:dec-M`
 * when the parent is a Spec) so source content stays untouched.
 *
 * Encoding happens here (not in DecisionLink) because react-markdown only invokes
 * component overrides for elements that exist in the parsed tree — and the bare
 * `[per dec-N]` syntax produces text nodes by default, which we can't intercept
 * via the `components` map. Pre-converting to a tag is the simplest path that
 * works with the standard plugin chain.
 */
function encodeDecisionRefs(content: string): string {
  return content.replace(
    /\[per ((?:(?:mis|doc)-\d+:)?dec-\d+)\]/g,
    (_match, handle: string) => `<decisionref handle="${handle}" />`,
  );
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeRaw, rehypeHighlight, rehypeRefLinkifier];

function StandardSection({
  section,
  sectionNumber,
  driftCount,
}: StandardSectionProps) {
  const title = section.title ?? capitalize(section.sectionType);
  const encoded = encodeDecisionRefs(section.content);
  const drifted = driftCount > 0;

  // react-markdown's component map is typed strictly — using `any` here keeps the
  // `decisionref` override accepted alongside the standard HTML element keys. The
  // ChatMarkdown component does the same.
  const components: Record<string, unknown> = {
    decisionref: ({ handle }: { handle?: string }) =>
      // b-42 t-2: scope bare-handle resolution to the standard's parent doc so
      // memexes with dec-1 in multiple Specs don't 409 on `[per dec-N]` links.
      handle ? <DecisionLink handle={handle} parentDocId={section.docId} /> : null,
  };

  return (
    <section
      data-testid="standard-section"
      data-section-id={section.id}
      data-drifted={drifted ? 'true' : 'false'}
      className="rounded-lg border border-edge-subtle bg-panel px-5 py-4"
    >
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-edge">
        {drifted && (
          <span
            data-testid="section-drift-indicator"
            title={`${driftCount} open drift comment${driftCount === 1 ? '' : 's'}`}
            className="inline-block w-2 h-2 rounded-full bg-status-danger-text shrink-0"
            aria-label={`${driftCount} open drift comments`}
          />
        )}
        <h2 className="text-lg font-semibold text-heading flex-1">
          <span className="text-muted mr-3 font-normal tabular-nums">
            {sectionNumber}
          </span>
          {title}
        </h2>
        {drifted && (
          <span
            data-testid="section-drift-badge"
            className="text-xs font-medium px-2 py-0.5 rounded-full bg-status-danger-bg text-status-danger-text border border-status-danger-border"
          >
            {driftCount} drift
          </span>
        )}
      </div>
      <div className="prose-dark overflow-hidden">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components as never}
        >
          {encoded}
        </ReactMarkdown>
      </div>
    </section>
  );
}

function capitalize(s: string): string {
  return s
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
