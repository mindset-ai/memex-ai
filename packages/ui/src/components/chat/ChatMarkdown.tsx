import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { ChatDecisionCard } from './ChatDecisionCard';
import { ChatSectionLink } from './ChatSectionLink';
import { ChatTaskCard } from './ChatTaskCard';
import { Badge } from '../ui';
import { rehypeRefLinkifier } from './refLinkifier';
import { specRefComponents } from '../specRef/specRefAnchor';
import { rehypeSpecRefLinkifier } from './specRefLinkifier';

/**
 * Renders assistant markdown with embedded MDX components.
 * Uses rehype-raw to parse custom HTML tags inline, preserving full markdown context.
 */
export function ChatMarkdown({ content }: { content: string }) {
  const components = {
    a: specRefComponents.a,
    decisioncard: ({ id }: { id?: string }) =>
      id ? <ChatDecisionCard id={id} /> : null,
    sectionlink: ({ id }: { id?: string }) =>
      id ? <ChatSectionLink id={id} /> : null,
    taskcard: ({ id }: { id?: string }) =>
      id ? <ChatTaskCard id={id} /> : null,
    statusbadge: ({ status }: { status?: string }) =>
      status ? <Badge status={status} /> : null,
  };

  return (
    <div
      data-testid="chat-markdown"
      // spec-389: render through the app's THEME-AWARE prose class. The Tailwind
      // Typography plugin isn't installed, so `prose`/`prose-invert`/`prose-slate`
      // were dead no-op classes — chat text fell back to an inherited near-white
      // colour that washed out on the light-mode panel (the same class of bug as the
      // #337 `--color-body` fix). `.prose-dark` (despite its name) colours every
      // element from the `--ch-text-*` channels, which flip per `.light`/`.dark`, so
      // it reads correctly in both modes — and matches how Standards/Decisions render
      // markdown elsewhere in the app.
      className="prose-dark max-w-none text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight, rehypeRefLinkifier, rehypeSpecRefLinkifier]}
        components={components as any}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
