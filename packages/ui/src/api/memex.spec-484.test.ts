// spec-484 t-1 (dec-1) — the public shared-document read decodes its titles too, so a
// shared Spec renders "Architecture & Security", never the raw "&amp;".
//
//   ac-2  — shared-doc titles (doc + section) are decoded on read.
//   ac-3  — the same shared decoder is applied here as in fetchDocs/splitSection.
//   ac-4  — section CONTENT is not decoded (only titles).
//   ac-11 — getSharedDocumentApi applies the normalizer (not only fetchDoc).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { getSharedDocumentApi } from './memex';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

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

describe('spec-484: getSharedDocumentApi decode-on-read', () => {
  it('ac-2 / ac-11: the doc title and section titles are decoded', async () => {
    tagAc(AC(2));
    tagAc(AC(11));
    mockFetchJson({
      doc: {
        id: 'd1',
        memexId: 'm1',
        handle: 'spec-1',
        title: 'Architecture &amp;amp; Security',
        docType: 'spec',
        status: 'draft',
        createdAt: '2026-01-01',
        statusChangedAt: '2026-01-01',
      },
      sections: [
        { id: 's1', docId: 'd1', sectionType: 'lens', title: 'Design &amp; UX', content: 'body', seq: 0, createdAt: '', updatedAt: '' },
        { id: 's2', docId: 'd1', sectionType: 'lens', title: null, content: 'body', seq: 1, createdAt: '', updatedAt: '' },
      ],
      namespaceSlug: 'ns',
      memexName: 'MX',
      comments: [],
    });
    const dto = await getSharedDocumentApi('tok');
    // Double-encoded doc title fully resolves; single-encoded section title decodes.
    expect(dto.doc.title).toBe('Architecture & Security');
    expect(dto.sections[0].title).toBe('Design & UX');
    expect(dto.sections[1].title).toBeNull();
  });

  it('ac-4: section content is left untouched (titles only)', async () => {
    tagAc(AC(4));
    mockFetchJson({
      doc: {
        id: 'd1',
        memexId: 'm1',
        handle: 'spec-1',
        title: 'Clean Title',
        docType: 'spec',
        status: 'draft',
        createdAt: '2026-01-01',
        statusChangedAt: '2026-01-01',
      },
      sections: [
        { id: 's1', docId: 'd1', sectionType: 'lens', title: 'A &amp; B', content: 'code `x &amp; y` and &lt;t&gt;', seq: 0, createdAt: '', updatedAt: '' },
      ],
      namespaceSlug: 'ns',
      memexName: 'MX',
      comments: [],
    });
    const dto = await getSharedDocumentApi('tok');
    expect(dto.sections[0].title).toBe('A & B'); // title decoded
    expect(dto.sections[0].content).toBe('code `x &amp; y` and &lt;t&gt;'); // content verbatim
  });
});
