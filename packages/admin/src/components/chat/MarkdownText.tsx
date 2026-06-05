import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { rehypeRefLinkifier } from './refLinkifier';

/**
 * Compact markdown renderer for short-to-medium LLM-sourced strings that appear
 * inside UI-tool renderers (callout headings, confirmation messages, step
 * labels, option descriptions, etc.).
 *
 * Two modes:
 * - **inline** (default): unwraps paragraphs so the rendered markdown flows
 *   inline with surrounding layout — use for labels, single-line text, and
 *   fields that sit inside their own container element.
 * - **block**: preserves paragraphs with light spacing — use for multi-sentence
 *   bodies like a callout body or a confirmation message with multiple paragraphs.
 *
 * Always use this for text that originates from the LLM so that **bold**,
 * *italic*, `code`, and [links](…) render properly instead of showing as
 * literal markdown syntax.
 */
export function MarkdownText({
  children,
  inline = true,
  className = '',
}: {
  children: string;
  inline?: boolean;
  className?: string;
}) {
  if (!children) return null;

  if (inline) {
    const components: Components = {
      p: ({ children: c }) => <>{c}</>,
      a: ({ children: c, href }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-accent hover:text-accent/80">
          {c}
        </a>
      ),
    };
    return (
      <span className={className}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRefLinkifier]}
          components={components}
        >
          {children}
        </ReactMarkdown>
      </span>
    );
  }

  return (
    <div
      className={`${className} [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-overlay [&_code]:text-xs`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRefLinkifier]}
        components={{
          a: ({ children: c, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-accent hover:text-accent/80">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
