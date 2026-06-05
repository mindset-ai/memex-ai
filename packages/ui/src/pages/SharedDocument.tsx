import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { rehypeRefLinkifier } from '../components/chat/refLinkifier';
import { Button } from '../components/ui/Button';
import { TextArea } from '../components/ui/TextArea';
import {
  getSharedDocumentApi,
  postSharedCommentApi,
  ShareAccessError,
  type SharedDocumentDto,
  type SharedCommentDto,
} from '../api/client';
import { buildBareDomainUrl } from '../utils/tenantUrl';
// t-23 of doc-15: buildBareDomainUrl now returns ${origin}/ — no subdomain
// stripping. Used here to build the "sign in to comment" return-to link.

type Status = 'loading' | 'loaded' | 'error';

const ERROR_MESSAGES: Record<string, string> = {
  unknown: 'This share link is not valid. Please check the URL or ask the person who shared the document to send a new link.',
  revoked: 'This link has been revoked.',
};

// Public read-only viewer for shared documents (t-10 + t-11). Lives at /share/:token.
// Rendered OUTSIDE AuthProvider so guests can view without signing in.
//
// t-11 additions:
// - Displays existing comments with "External" badge when authorNamespaceId != memex.namespaceId
// - Guest users see "Sign in to comment" → redirects to signup with returnTo + ref params
// - Authenticated users see inline comment form and can post via the public endpoint
export function SharedDocument() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<SharedDocumentDto | null>(null);
  const [error, setError] = useState<{ reason: string; message: string } | null>(null);

  // The shared viewer lives outside AuthProvider so we read auth state directly from
  // localStorage. The Google ID token there is our Bearer for comment posting.
  const bearerToken = typeof window !== 'undefined'
    ? window.localStorage.getItem('memex-auth-token')
    : null;
  const isAuthenticated = !!bearerToken;

  const fetchDoc = useCallback(async () => {
    if (!token) {
      setStatus('error');
      setError({ reason: 'unknown', message: ERROR_MESSAGES.unknown });
      return;
    }
    try {
      const result = await getSharedDocumentApi(token);
      setData(result);
      setStatus('loaded');
    } catch (err) {
      setStatus('error');
      if (err instanceof ShareAccessError) {
        setError({ reason: err.reason, message: ERROR_MESSAGES[err.reason] ?? err.message });
      } else {
        setError({ reason: 'unknown', message: 'Something went wrong loading this document.' });
      }
    }
  }, [token]);

  useEffect(() => {
    fetchDoc();
  }, [fetchDoc]);

  if (status === 'loading') return <CenteredMessage>Loading…</CenteredMessage>;

  if (status === 'error' && error) {
    return (
      <CenteredMessage>
        <h1 className="text-xl font-semibold text-heading mb-2">
          {error.reason === 'revoked' ? 'Link revoked' : 'Share link invalid'}
        </h1>
        <p className="text-sm text-secondary">{error.message}</p>
      </CenteredMessage>
    );
  }

  if (!data) return null;

  const commentsBySectionId = groupCommentsByKind(data.comments, 'sectionId');

  return (
    <div className="min-h-screen bg-page flex flex-col">
      <header className="border-b border-edge bg-page/80 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="text-sm text-muted">
            Shared by <span className="text-secondary">{data.memexName || data.namespaceSlug}</span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded bg-btn-secondary text-secondary">
            Read-only
          </span>
        </div>
      </header>

      <main className="flex-1">
        <article className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          <header>
            <h1 className="text-3xl font-semibold text-heading">{data.doc.title}</h1>
            <div className="text-xs text-muted mt-2">
              {data.doc.handle} · {data.doc.docType}
            </div>
          </header>

          {data.sections.map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              comments={commentsBySectionId.get(section.id) ?? []}
              hostMemexId={data.doc.memexId}
              isAuthenticated={isAuthenticated}
              bearerToken={bearerToken}
              shareToken={token ?? ''}
              onCommentPosted={fetchDoc}
            />
          ))}
        </article>
      </main>

      <footer className="border-t border-edge py-6">
        <div className="max-w-3xl mx-auto px-6 text-center text-xs text-muted">
          Created with{' '}
          <a
            href="https://memex.ai"
            target="_blank"
            rel="noreferrer"
            className="text-secondary hover:text-primary font-medium"
          >
            Memex<span className="text-[#7b93b8]">.ai</span>
          </a>
        </div>
      </footer>
    </div>
  );
}

function SectionBlock({
  section,
  comments,
  hostMemexId,
  isAuthenticated,
  bearerToken,
  shareToken,
  onCommentPosted,
}: {
  section: SharedDocumentDto['sections'][number];
  comments: SharedCommentDto[];
  hostMemexId: string;
  isAuthenticated: boolean;
  bearerToken: string | null;
  shareToken: string;
  onCommentPosted: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onStartCommenting = useCallback(() => {
    if (isAuthenticated) {
      setComposing(true);
      return;
    }
    // Guest: redirect to signup with returnTo + ref (for viral attribution).
    // Return URL is URL-encoded; the signup flow will bounce back here after account creation.
    const returnTo = window.location.href;
    const signupUrl = `${buildBareDomainUrl('/')}?returnTo=${encodeURIComponent(returnTo)}&ref=${encodeURIComponent(shareToken)}`;
    window.location.href = signupUrl;
  }, [isAuthenticated, shareToken]);

  const onSubmit = useCallback(async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await postSharedCommentApi(
        shareToken,
        bearerToken,
        { kind: 'section', id: section.id },
        content.trim()
      );
      setContent('');
      setComposing(false);
      onCommentPosted();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [content, shareToken, bearerToken, section.id, onCommentPosted]);

  return (
    <section className="space-y-3">
      {section.title && <h2 className="text-xl font-semibold text-heading">{section.title}</h2>}
      <div className="prose prose-sm max-w-none text-primary">
        <ReactMarkdown rehypePlugins={[rehypeRefLinkifier]}>{section.content}</ReactMarkdown>
      </div>

      {/* Comments list */}
      {comments.length > 0 && (
        <div className="space-y-2 mt-4 pl-4 border-l-2 border-edge">
          {comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} hostMemexId={hostMemexId} />
          ))}
        </div>
      )}

      {/* Comment affordance */}
      <div className="pt-2">
        {!composing ? (
          <button
            onClick={onStartCommenting}
            className="text-xs text-muted hover:text-secondary"
          >
            {isAuthenticated ? '+ Add comment' : '+ Sign in to comment'}
          </button>
        ) : (
          <div className="space-y-2">
            <TextArea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Add your comment…"
              rows={3}
            />
            {submitError && (
              <div className="text-xs text-status-danger-text">{submitError}</div>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setComposing(false)}>
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={submitting || !content.trim()} size="sm">
                {submitting ? 'Posting…' : 'Post comment'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function CommentRow({
  comment,
  hostMemexId,
}: {
  comment: SharedCommentDto;
  hostMemexId: string;
}) {
  const isExternal =
    comment.authorNamespaceId !== null && comment.authorNamespaceId !== hostMemexId;

  return (
    <div className="text-sm space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium text-secondary">{comment.authorName}</span>
        {isExternal && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-status-warning-bg text-status-warning-text">
            External
          </span>
        )}
        <span className="text-muted">
          {new Date(comment.createdAt).toLocaleDateString()}
        </span>
      </div>
      <div className="text-primary whitespace-pre-wrap">{comment.content}</div>
    </div>
  );
}

function groupCommentsByKind(
  comments: SharedCommentDto[],
  kind: 'sectionId' | 'decisionId' | 'taskId'
): Map<string, SharedCommentDto[]> {
  const map = new Map<string, SharedCommentDto[]>();
  for (const c of comments) {
    const targetId = c[kind];
    if (!targetId) continue;
    if (!map.has(targetId)) map.set(targetId, []);
    map.get(targetId)!.push(c);
  }
  return map;
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-4">
        <h1 className="text-2xl font-semibold text-heading">
          memex<span className="text-[#7b93b8]">.ai</span>
        </h1>
        <div className="text-sm text-secondary">{children}</div>
      </div>
    </div>
  );
}
