import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { tagAc } from '@memex-ai-ac/vitest';
import { rehypeRefLinkifier } from './refLinkifier';
import { rehypeSpecRefLinkifier } from './specRefLinkifier';

/**
 * Mirrors the shipped render config: `rehype-raw`, then the canonical-path
 * linkifier, then the bare-handle one. Order matters — the canonical-path
 * plugin runs FIRST so the path form is already an anchor by the time this
 * plugin walks, and anchors are skipped wholesale.
 */
function renderMd(content: string) {
  return render(
    <ReactMarkdown
      rehypePlugins={[rehypeRaw, rehypeRefLinkifier, rehypeSpecRefLinkifier]}
    >
      {content}
    </ReactMarkdown>,
  );
}

function getSpecRefs(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('a[data-spec-ref="true"]'),
  );
}

function handles(container: HTMLElement): string[] {
  return getSpecRefs(container).map((a) => a.getAttribute('data-spec-handle') ?? '');
}

describe('rehypeSpecRefLinkifier', () => {
  it('turns a bare spec-N into an anchor carrying the handle', () => {
    const { container } = renderMd('The board work lands in spec-335 this week.');
    const refs = getSpecRefs(container);
    expect(refs).toHaveLength(1);
    expect(refs[0].getAttribute('data-spec-handle')).toBe('spec-335');
    expect(refs[0].textContent).toBe('spec-335');
  });

  it('matches every handle in one text node and preserves the surrounding prose', () => {
    const { container } = renderMd(
      'Only spec-335, spec-373 and spec-371 have shipped code.',
    );
    expect(handles(container)).toEqual(['spec-335', 'spec-373', 'spec-371']);
    expect(container.textContent).toBe(
      'Only spec-335, spec-373 and spec-371 have shipped code.',
    );
  });

  it('matches a handle abutting punctuation without swallowing it', () => {
    const { container } = renderMd('Superseded by spec-372. (see spec-162, too)');
    expect(handles(container)).toEqual(['spec-372', 'spec-162']);
    expect(container.textContent).toBe(
      'Superseded by spec-372. (see spec-162, too)',
    );
  });

  it('leaves handles inside inline code and fenced blocks verbatim', () => {
    const { container } = renderMd(
      'Use `spec-335` as the ref.\n\n```\nget_doc spec-373\n```\n',
    );
    expect(getSpecRefs(container)).toHaveLength(0);
    expect(container.querySelector('code')?.textContent).toBe('spec-335');
  });

  it('does not double-link a handle already inside an anchor', () => {
    // The handle must be in the anchor's TEXT, not just its href — otherwise the
    // assertion passes even with 'a' removed from the skip set.
    const { container } = renderMd('[spec-335](/x/y/specs/spec-335)');
    expect(getSpecRefs(container)).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(1);
  });

  it('leaves the handle inside a full canonical path to the path linkifier', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-8');
    const { container } = renderMd(
      'See mindset-prod/mindset-four/specs/spec-335 for the board work.',
    );
    // The canonical-path plugin still owns this form, unchanged by our arrival.
    const pathLinks = container.querySelectorAll('a[data-ref-link="true"]');
    expect(pathLinks).toHaveLength(1);
    expect(pathLinks[0].textContent).toBe(
      'mindset-prod/mindset-four/specs/spec-335',
    );
    // And the bare matcher does NOT also fire inside it.
    expect(getSpecRefs(container)).toHaveLength(0);
  });

  it('matches spec-N only — std-N and doc-N stay plain text', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-12');
    const { container } = renderMd(
      'Governed by std-10 and described in doc-36, delivered by spec-529.',
    );
    expect(handles(container)).toEqual(['spec-529']);
    expect(container.textContent).toBe(
      'Governed by std-10 and described in doc-36, delivered by spec-529.',
    );
  });

  it('ignores handle-shaped text that is part of a longer token', () => {
    const { container } = renderMd('sub-spec-3 and spec-3a and myspec-4 are prose.');
    expect(getSpecRefs(container)).toHaveLength(0);
  });

  it('rejects loose forms — leading zeros, a zero, and case variants', () => {
    const { container } = renderMd('Not spec-007, not spec-0, not Spec-3, not SPEC-3.');
    expect(getSpecRefs(container)).toHaveLength(0);
  });

  it('leaves a body with no handles structurally untouched', () => {
    const { container } = renderMd('Nothing to see here.');
    expect(getSpecRefs(container)).toHaveLength(0);
    expect(container.textContent).toBe('Nothing to see here.');
  });
});
