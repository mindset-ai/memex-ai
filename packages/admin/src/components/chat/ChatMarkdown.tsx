import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import { ChatDecisionCard } from './ChatDecisionCard';
import { ChatSectionLink } from './ChatSectionLink';
import { ChatTaskCard } from './ChatTaskCard';
import { Badge } from '../ui';
import { rehypeRefLinkifier } from './refLinkifier';

/**
 * Renders assistant markdown with embedded MDX components.
 * Uses rehype-raw to parse custom HTML tags inline, preserving full markdown context.
 */
export function ChatMarkdown({ content }: { content: string }) {
  const components = {
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
      className="prose prose-sm prose-invert prose-slate max-w-none text-sm
      [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
      [&_p]:my-3 [&_ul]:my-3 [&_ol]:my-3 [&_li]:my-1
      [&_h1]:mt-5 [&_h1]:mb-3 [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:mt-3 [&_h3]:mb-2
      [&_blockquote]:my-3 [&_pre]:my-3"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight, rehypeRefLinkifier]}
        components={components as any}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
