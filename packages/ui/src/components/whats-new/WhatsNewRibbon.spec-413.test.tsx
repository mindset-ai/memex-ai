// spec-413 — What's New body text legibility
// ac-1: body copy under WHAT/WHY renders in text-primary (not light grey)
// ac-2: WHAT/WHY section labels remain text-muted (visually subordinate)
// ac-3: text-primary class is present (correct token for both light + dark mode)

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { WhatsNewRibbon } from './WhatsNewRibbon';
import type { WhatsNewEntry } from '../../api/whatsNew';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-413/acs/ac-${n}`;

const ENTRY: WhatsNewEntry = {
  id: 'spec-413-fixture',
  sourceSpecRef: 'mindset-prod/memex-building-itself/specs/spec-413',
  sourceSpecHandle: 'spec-413',
  title: 'Fix: What\'s New body text legibility',
  what: 'Body copy for the What field.',
  why: 'Body copy for the Why field.',
  publishedAt: '2026-06-25T10:00:00Z',
};

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('WhatsNewRibbon body text legibility (spec-413)', () => {
  it('WHAT/WHY paragraphs carry text-primary; labels carry text-muted (ac-1, ac-2, ac-3)', async () => {
    render(<WhatsNewRibbon fetcher={async () => ({ entries: [ENTRY], suppressBefore: undefined })} onExplain={() => {}} />);

    const ribbon = await screen.findByTestId('whats-new-ribbon');
    fireEvent.click(ribbon);
    const popup = await screen.findByTestId('whats-new-popup');

    // Every body paragraph inside an article must carry text-primary (ac-1, ac-3).
    const bodyPs = popup.querySelectorAll('article p.text-primary');
    expect(bodyPs.length).toBeGreaterThanOrEqual(2);
    tagAc(AC(1));
    tagAc(AC(3));

    // The WHAT/WHY label spans inside those paragraphs must carry text-muted (ac-2).
    const labelSpans = popup.querySelectorAll('article p.text-primary span.text-muted');
    expect(labelSpans.length).toBeGreaterThanOrEqual(2);
    const labelTexts = Array.from(labelSpans).map((s) => s.textContent?.trim());
    expect(labelTexts).toContain('What');
    expect(labelTexts).toContain('Why');
    tagAc(AC(2));
  });
});
