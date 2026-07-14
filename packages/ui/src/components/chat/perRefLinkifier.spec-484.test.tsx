import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { tagAc } from '@memex-ai-ac/vitest';
import { rehypePerRefLinkifier, PER_REF_PATTERN } from './perRefLinkifier';

// spec-484 t-2 / dec-2 — perRefLinkifier is the companion rehype plugin that
// keeps the `[per dec-N]` / `[per t-N]` shorthand linkified once comment bodies
// render through markdown. This file unit-tests the plugin directly (ac-14),
// mirroring refLinkifier.test.tsx's render-the-full-hast-pipeline approach.

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

function renderMd(content: string) {
  return render(
    <ReactMarkdown rehypePlugins={[rehypeRaw, rehypePerRefLinkifier]}>
      {content}
    </ReactMarkdown>,
  );
}

function getPerLinks(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('a.per-ref-link'),
  );
}

describe('rehypePerRefLinkifier (spec-484 ac-14)', () => {
  it('ac-14: turns [per dec-N] into a dec-routed anchor', () => {
    tagAc(AC(14));
    const { container } = renderMd('See [per dec-3] for the rationale.');
    const links = getPerLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-per-ref')).toBe('dec');
    expect(links[0].getAttribute('data-per-handle')).toBe('dec-3');
    expect(links[0].textContent).toBe('dec-3');
  });

  it('ac-14: turns [per t-N] into a task-routed anchor', () => {
    tagAc(AC(14));
    const { container } = renderMd('Blocked by [per t-5].');
    const links = getPerLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-per-ref')).toBe('task');
    expect(links[0].getAttribute('data-per-handle')).toBe('t-5');
  });

  it('ac-14: handles the qualified [per doc-N:dec-M] cite form', () => {
    tagAc(AC(14));
    const { container } = renderMd('Per [per doc-12:dec-4] we chose X.');
    const links = getPerLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-per-ref')).toBe('dec');
    expect(links[0].getAttribute('data-per-handle')).toBe('doc-12:dec-4');
  });

  it('ac-14: does NOT linkify shorthand inside inline code', () => {
    tagAc(AC(14));
    const { container } = renderMd('Write `[per dec-3]` literally in code.');
    expect(getPerLinks(container)).toHaveLength(0);
    const code = container.querySelector('code');
    expect(code?.textContent).toBe('[per dec-3]');
  });

  it('ac-14: does NOT linkify shorthand inside fenced code blocks', () => {
    tagAc(AC(14));
    const md = ['```', '[per dec-3]', '[per t-1]', '```'].join('\n');
    const { container } = renderMd(md);
    expect(getPerLinks(container)).toHaveLength(0);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('[per dec-3]');
  });

  it('ac-14: does NOT double-link inside an existing anchor', () => {
    tagAc(AC(14));
    const { container } = renderMd('Link: <a href="/x">[per dec-3]</a>.');
    const all = container.querySelectorAll('a');
    expect(all).toHaveLength(1);
    expect(all[0].getAttribute('href')).toBe('/x');
    expect(getPerLinks(container)).toHaveLength(0);
  });

  it('ac-14: preserves surrounding text and handles multiple refs', () => {
    tagAc(AC(14));
    const { container } = renderMd('Before [per dec-1] and [per t-9] after.');
    const links = getPerLinks(container);
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('data-per-handle')).toBe('dec-1');
    expect(links[1].getAttribute('data-per-handle')).toBe('t-9');
    // The paragraph still carries the surrounding prose intact.
    expect(container.querySelector('p')?.textContent).toBe(
      'Before dec-1 and t-9 after.',
    );
  });

  it('ac-14: leaves non-matching bracketed text alone', () => {
    tagAc(AC(14));
    const { container } = renderMd('This [per whatever] is not a ref.');
    expect(getPerLinks(container)).toHaveLength(0);
  });

  it('PER_REF_PATTERN matches the three cite forms + task handles', () => {
    // Structural guard: keep the pattern in lock-step with DecisionLink's
    // PER_REF_REGEX so the two ref surfaces never drift.
    for (const s of ['[per dec-3]', '[per mis-2:dec-4]', '[per doc-1:dec-9]', '[per t-7]']) {
      PER_REF_PATTERN.lastIndex = 0;
      expect(PER_REF_PATTERN.test(s), `${s} should match`).toBe(true);
    }
  });
});
