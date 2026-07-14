// spec-484 t-1 (dec-1) — decode-on-read is applied by EVERY title-returning read in
// docs.ts, not only fetchDoc.
//
//   ac-1  — fetchDocs returns decoded titles ("&amp;" -> "&").
//   ac-3  — a single shared normalizer is applied across fetchDocs + splitSection.
//   ac-4  — content/body fields are NOT decoded by the normalizer (only titles).
//   ac-11 — the normalizer is applied by fetchDocs and splitSection (not only fetchDoc).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { fetchDocs, splitSection } from './docs';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

// Stub global fetch with a JSON payload. The api layer resolves tBase() to the flat
// `/api` base in jsdom (no tenant path, no cached session), which is irrelevant here —
// we answer every request with the same body regardless of URL.
function mockFetchJson(body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('spec-484: docs.ts decode-on-read', () => {
  it('ac-1 / ac-11: fetchDocs decodes each summary title', async () => {
    tagAc(AC(1));
    tagAc(AC(11));
    mockFetchJson([
      {
        id: 'd1',
        handle: 'spec-1',
        title: 'Architecture &amp; Security',
        docType: 'spec',
        status: 'draft',
        parentDocId: null,
        createdAt: '2026-01-01',
        statusChangedAt: '2026-01-01',
        sectionCount: 0,
        archivedAt: null,
      },
    ]);
    const docs = await fetchDocs('spec');
    expect(docs[0].title).toBe('Architecture & Security');
  });

  it('ac-2 / ac-1: fetchDocs decodes the promoted-from parent title too', async () => {
    tagAc(AC(2));
    tagAc(AC(1));
    mockFetchJson([
      {
        id: 'd2',
        handle: 'spec-2',
        title: 'Child &amp; Heir',
        docType: 'spec',
        status: 'draft',
        parentDocId: 'p1',
        parent: { id: 'p1', handle: 'doc-9', title: 'Parent &amp;amp; Root', docType: 'document' },
        createdAt: '2026-01-01',
        statusChangedAt: '2026-01-01',
        sectionCount: 0,
        archivedAt: null,
      },
    ]);
    const docs = await fetchDocs('spec');
    expect(docs[0].title).toBe('Child & Heir');
    // Double-encoded parent label fully resolves via the fixpoint decoder.
    expect(docs[0].parent?.title).toBe('Parent & Root');
  });

  it('ac-3 / ac-11: splitSection decodes returned section titles', async () => {
    tagAc(AC(3));
    tagAc(AC(11));
    mockFetchJson([
      { id: 's1', docId: 'd1', sectionType: 'lens', title: 'Design &amp; UX', content: '', seq: 0 },
      { id: 's2', docId: 'd1', sectionType: 'lens', title: null, content: '', seq: 1 },
    ]);
    const sections = await splitSection('s1');
    expect(sections[0].title).toBe('Design & UX');
    expect(sections[1].title).toBeNull();
  });

  it('ac-4: the normalizer decodes titles but NOT body content', async () => {
    tagAc(AC(4));
    mockFetchJson([
      {
        id: 's1',
        docId: 'd1',
        sectionType: 'lens',
        title: 'Design &amp; UX',
        // Content carries entity-like text (e.g. a code span) that must survive verbatim.
        content: 'use `a &amp; b` and &lt;tag&gt; here',
        seq: 0,
      },
    ]);
    const sections = await splitSection('s1');
    expect(sections[0].title).toBe('Design & UX'); // title decoded
    expect(sections[0].content).toBe('use `a &amp; b` and &lt;tag&gt; here'); // content untouched
  });
});
