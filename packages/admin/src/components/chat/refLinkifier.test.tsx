import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { rehypeRefLinkifier } from './refLinkifier';

/**
 * Thin wrapper that mirrors the render config we ship in ChatMarkdown:
 * `rehype-raw` + `rehypeRefLinkifier`. Tests assert against the resulting
 * DOM so we exercise the full hast pipeline (parse → transform → render),
 * not just the regex.
 */
function renderMd(content: string) {
  return render(
    <ReactMarkdown rehypePlugins={[rehypeRaw, rehypeRefLinkifier]}>
      {content}
    </ReactMarkdown>,
  );
}

/**
 * Pulls every `<a data-ref-link="true">` element out of the rendered tree.
 * The data attribute is the marker the plugin stamps on auto-generated
 * anchors — matching on it keeps the assertion narrow.
 */
function getRefLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('a[data-ref-link="true"]'),
  );
}

describe('rehypeRefLinkifier', () => {
  it('linkifies a bare doc-level legacy spec ref (/briefs/b-N shape)', () => {
    const { container } = renderMd('See mindset-int/memex-app/briefs/b-36 for details.');
    const links = getRefLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/mindset-int/memex-app/briefs/b-36');
    expect(links[0].textContent).toBe('mindset-int/memex-app/briefs/b-36');
  });

  it('linkifies a doc + task child ref', () => {
    const { container } = renderMd(
      'Task: mindset-int/memex-app/docs/doc-28/tasks/t-1',
    );
    const links = getRefLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(
      '/mindset-int/memex-app/docs/doc-28/tasks/t-1',
    );
  });

  it('linkifies each child type', () => {
    const cases = [
      {
        input: 'mindset-int/memex-app/docs/doc-1/sections/s-2',
        href: '/mindset-int/memex-app/docs/doc-1/sections/s-2',
      },
      {
        input: 'mindset-int/memex-app/briefs/b-9/decisions/dec-3',
        href: '/mindset-int/memex-app/briefs/b-9/decisions/dec-3',
      },
      {
        input: 'mindset-int/memex-app/docs/doc-28/tasks/t-1',
        href: '/mindset-int/memex-app/docs/doc-28/tasks/t-1',
      },
      {
        input: 'mindset-int/memex-app/briefs/b-2/comments/c-7',
        href: '/mindset-int/memex-app/briefs/b-2/comments/c-7',
      },
    ];

    for (const c of cases) {
      const { container } = renderMd(c.input);
      const links = getRefLinks(container);
      expect(links, `expected one link for ${c.input}`).toHaveLength(1);
      expect(links[0].getAttribute('href')).toBe(c.href);
      expect(links[0].textContent).toBe(c.input);
    }
  });

  it('also linkifies standard and execution-plan doc types', () => {
    const standard = renderMd('mindset-int/memex-app/standards/std-4');
    const execPlan = renderMd('mindset-int/memex-app/execution-plans/doc-12');
    expect(getRefLinks(standard.container)[0]?.getAttribute('href')).toBe(
      '/mindset-int/memex-app/standards/std-4',
    );
    expect(getRefLinks(execPlan.container)[0]?.getAttribute('href')).toBe(
      '/mindset-int/memex-app/execution-plans/doc-12',
    );
  });

  it('does NOT linkify refs inside inline code', () => {
    const { container } = renderMd(
      'Compare `mindset-int/memex-app/briefs/b-36` with the prose version.',
    );
    expect(getRefLinks(container)).toHaveLength(0);
    // Verify the ref text still survives inside the <code> element.
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('mindset-int/memex-app/briefs/b-36');
  });

  it('does NOT linkify refs inside fenced code blocks', () => {
    const md = [
      '```',
      'mindset-int/memex-app/briefs/b-36',
      'mindset-int/memex-app/docs/doc-28/tasks/t-1',
      '```',
    ].join('\n');
    const { container } = renderMd(md);
    expect(getRefLinks(container)).toHaveLength(0);
    // Ref text should still be present inside the <pre><code> block.
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('mindset-int/memex-app/briefs/b-36');
  });

  it('does NOT linkify plain paths that are not Memex refs', () => {
    const { container } = renderMd(
      'See src/services/refs.ts and packages/admin/README.md for context.',
    );
    expect(getRefLinks(container)).toHaveLength(0);
  });

  it('does NOT double-link inside an existing anchor', () => {
    // rehype-raw lets a raw <a> in the markdown survive into hast.
    const { container } = renderMd(
      'Link: <a href="/x">mindset-int/memex-app/briefs/b-36</a>.',
    );
    // Only the original anchor exists; the plugin should leave it alone.
    const all = container.querySelectorAll('a');
    expect(all).toHaveLength(1);
    expect(all[0].getAttribute('href')).toBe('/x');
    // And no anchor carries the plugin's data attribute.
    expect(getRefLinks(container)).toHaveLength(0);
  });

  it('renders surrounding text correctly when a ref sits inside a paragraph', () => {
    const { container } = renderMd(
      'Before mindset-int/memex-app/briefs/b-36 after.',
    );
    const paragraph = container.querySelector('p')!;
    // Three child nodes: text, anchor, text.
    expect(paragraph.childNodes).toHaveLength(3);
    expect(paragraph.childNodes[0].textContent).toBe('Before ');
    expect((paragraph.childNodes[1] as HTMLElement).tagName).toBe('A');
    expect(paragraph.childNodes[2].textContent).toBe(' after.');
  });

  it('handles multiple refs in a single paragraph', () => {
    const { container } = renderMd(
      'See mindset-int/memex-app/briefs/b-36 and mindset-int/memex-app/docs/doc-1/tasks/t-9 together.',
    );
    const links = getRefLinks(container);
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/mindset-int/memex-app/briefs/b-36');
    expect(links[1].getAttribute('href')).toBe(
      '/mindset-int/memex-app/docs/doc-1/tasks/t-9',
    );
  });

  it('matches refs adjacent to punctuation without swallowing trailing chars', () => {
    const { container } = renderMd(
      '(mindset-int/memex-app/briefs/b-36), then continue.',
    );
    const links = getRefLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/mindset-int/memex-app/briefs/b-36');
  });
});
