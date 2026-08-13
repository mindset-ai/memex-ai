// spec-529 t-6 (ac-5) — the export path is a NON-BROWSER reader of the same body,
// and it must be untouched by the rendering feature.
//
// Linkification is render-time only; storage stays plain markdown. So a Spec
// exported to markdown carries the handle exactly as the author typed it — no
// anchor, no pill markup, no injected status. If this ever fails, the feature has
// leaked out of the renderer and into the content.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { specToMarkdown } from './specMarkdown';
import type { DocWithGraph } from '../api/types';

const OPTIONS = {
  includeSections: true,
  includeDecisions: true,
  includeTasks: true,
  includeComments: false,
};

const EMPTY_COMMENTS = { bySection: {}, byDecision: {}, byTask: {} };

function docMentioning(text: string): DocWithGraph {
  return {
    id: 'doc-id',
    handle: 'doc-36',
    title: 'Where the observability work stands',
    docType: 'document',
    status: 'draft',
    createdAt: '2026-08-01T10:00:00Z',
    statusChangedAt: '2026-08-01T10:00:00Z',
    sections: [
      { id: 's1', seq: 1, sectionType: 'overview', title: 'Overview', content: text },
    ],
    decisions: [],
    tasks: [],
  } as unknown as DocWithGraph;
}

describe('markdown export keeps bare handles verbatim', () => {
  it('exports `spec-N` as plain text, with no anchor or status', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-529/acs/ac-5');
    const body =
      'Only spec-335, spec-373 and spec-371 have shipped code; spec-372 is next.';
    const out = specToMarkdown(docMentioning(body), EMPTY_COMMENTS, OPTIONS);

    expect(out).toContain(body);
    expect(out).not.toContain('data-spec-ref');
    expect(out).not.toContain('spec-ref-pill');
    expect(out).not.toContain('](/');
    // No status was injected beside any handle.
    expect(out).not.toMatch(/spec-335\s*·/);
    expect(out).not.toMatch(/tasks complete/);
  });

  it('leaves a handle inside a code span exactly where the author put it', () => {
    const body = 'Call `get_doc spec-373` to read it.';
    const out = specToMarkdown(docMentioning(body), EMPTY_COMMENTS, OPTIONS);
    expect(out).toContain('`get_doc spec-373`');
  });
});
