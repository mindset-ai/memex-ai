// spec-552 t-5 — the ninth Insights card.
//
// Written BEFORE the component (TDD). The assertions that matter are the two
// honesty properties, because they are the card's whole value:
//
//   ac-10 — every figure, INCLUDING the window, comes from the response. A
//           literal anywhere is a number that stops being true without
//           anything detecting it.
//   ac-13 — every token figure is marked as an estimate AND its exact
//           character count is on the row, so a reader who distrusts our
//           divisor can recompute instead of taking it on faith.
//
// Plus the three states: figures, not-enough-activity, and absent.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';
import { CostPanelCard } from './CostPanelCard';
import type { CostPanelResponse } from '../../api/insights';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;
const HERE = dirname(fileURLToPath(import.meta.url));

function populated(over: Partial<{ windowDays: number }> = {}): CostPanelResponse {
  return {
    available: true,
    windowDays: over.windowDays ?? 30,
    totals: { calls: 120, totalChars: 546_000, guidanceChars: 174_720 },
    operations: [
      {
        tool: 'get_doc',
        verb: null,
        calls: 60,
        medianChars: 4_428,
        p90Chars: 31_947,
        guidanceChars: 100_296,
        totalChars: 400_000,
      },
      {
        // The 95%-guidance shape — the row the card exists to make visible.
        tool: 'add_comment',
        verb: null,
        calls: 60,
        medianChars: 1_685,
        p90Chars: 1_764,
        guidanceChars: 96_000,
        totalChars: 101_100,
      },
    ],
  };
}

describe('CostPanelCard — the three states', () => {
  it('renders nothing at all when the payload says the panel is unavailable', () => {
    tagAc(AC(5));
    // Not a placeholder, not an error, not an empty frame: the page must look
    // exactly as it does today for a Memex outside the rollout, or for a caller
    // who is not a member.
    const { container } = render(<CostPanelCard data={{ available: false }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a not-enough-activity state instead of a statistic over a handful of calls', () => {
    tagAc(AC(5));
    const thin: CostPanelResponse = {
      available: true,
      windowDays: 30,
      totals: { calls: 2, totalChars: 900, guidanceChars: 300 },
      operations: [
        {
          tool: 'create_ac',
          verb: null,
          calls: 2,
          medianChars: 450,
          p90Chars: 460,
          guidanceChars: 300,
          totalChars: 900,
        },
      ],
    };
    render(<CostPanelCard data={thin} />);
    expect(screen.getByText(/not enough activity/i)).toBeTruthy();
    // A median drawn from two calls must not be presented as a figure.
    expect(screen.queryByText('450')).toBeNull();
  });

  it('renders the per-operation rows once there is enough activity', () => {
    tagAc(AC(2));
    render(<CostPanelCard data={populated()} />);
    expect(screen.getByText('get_doc')).toBeTruthy();
    expect(screen.getByText('add_comment')).toBeTruthy();
  });
});

describe('CostPanelCard — ac-10: every figure comes from the response', () => {
  it('renders the window from the payload, not a hardcoded label', () => {
    tagAc(AC(10));
    // ac-3's render half: the displayed figure tracks the response, so a number
    // that stopped being true cannot survive on screen. Paired with the server
    // half (the aggregate computing from real rows) this is the whole claim.
    tagAc(AC(3));
    const { unmount } = render(<CostPanelCard data={populated({ windowDays: 30 })} />);
    expect(screen.getByText(/last 30 days/i)).toBeTruthy();
    unmount();

    // Change the response and the label must change with it. A literal "30"
    // would pass the first assertion and fail this one — which is the point.
    render(<CostPanelCard data={populated({ windowDays: 7 })} />);
    expect(screen.getByText(/last 7 days/i)).toBeTruthy();
    expect(screen.queryByText(/last 30 days/i)).toBeNull();
  });

  it('no cost figure or window number is a literal in the source', () => {
    tagAc(AC(10));
    // Comments are stripped first: the file's own prose cites measured figures,
    // and a naive scan matches its documentation rather than its code. (Every
    // source guard on this Spec has tripped on exactly that.)
    const code = readFileSync(join(HERE, 'CostPanelCard.tsx'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // A window length or a payload size written into the component would be a
    // number that silently stops being true.
    for (const forbidden of ['30 days', '4,428', '31,947', '1,685']) {
      expect(code).not.toContain(forbidden);
    }
    // The threshold is the one exception and it is a named constant, not an
    // inline digit in the JSX.
    expect(code).toMatch(/MIN_CALLS_FOR_FIGURES/);
  });
});

describe('CostPanelCard — ac-13: estimates are marked, characters are reachable', () => {
  it('marks every token figure as an estimate', () => {
    tagAc(AC(13));
    render(<CostPanelCard data={populated()} />);
    // The card converts characters to tokens with a measured constant, not a
    // known quantity — so no token figure may read as exact.
    const approx = screen.getAllByText(/≈/);
    expect(approx.length).toBeGreaterThan(0);
    // And it says HOW, once, so the reader can judge the estimate.
    expect(screen.getByText(/estimated from characters/i)).toBeTruthy();
  });

  it('puts the exact character count on the row beside the estimate', () => {
    tagAc(AC(13));
    render(<CostPanelCard data={populated()} />);
    // get_doc's median is 4,428 characters. The token figure is derived; the
    // character count is measured, so it is the one a sceptic recomputes from.
    expect(screen.getByText(/4,428/)).toBeTruthy();
  });

  it('derives token figures through the shared constant, never its own arithmetic', () => {
    tagAc(AC(13));
    const code = readFileSync(join(HERE, 'CostPanelCard.tsx'), 'utf8');
    // One conversion in the codebase (t-4). A second divisor here would put two
    // disagreeing numbers on the same page with nothing failing.
    expect(code).toMatch(/estimateTokens/);
    expect(code).not.toMatch(/\/\s*2\.7|\/\s*3\b|CHARS_PER_TOKEN\s*\)/);
  });
});

describe('CostPanelCard — ac-4: the unmeasurable question is answered in place', () => {
  it('states that no comparison with not using Memex is offered', () => {
    tagAc(AC(4));
    render(<CostPanelCard data={populated()} />);
    // A reader seeing a total immediately asks "versus what?". If the card is
    // silent they invent a baseline; the Spec's finding is that no honest one
    // exists, so the card says so rather than implying a saving.
    expect(screen.getByText(/can't measure|cannot measure/i)).toBeTruthy();
  });
});

describe('CostPanelCard — ac-2: median and p90, never a bare mean', () => {
  it('shows both median and p90 per operation', () => {
    tagAc(AC(2));
    render(<CostPanelCard data={populated()} />);
    expect(screen.getByText(/median/i)).toBeTruthy();
    expect(screen.getByText(/p90/i)).toBeTruthy();
  });

  it('never labels a figure as an average or a mean', () => {
    tagAc(AC(2));
    render(<CostPanelCard data={populated()} />);
    // get_doc runs 4,428 median against 31,947 p90 — a factor of 7. One number
    // would tell most readers something false about their own usage.
    expect(screen.queryByText(/\baverage\b/i)).toBeNull();
    expect(screen.queryByText(/\bmean\b/i)).toBeNull();
  });

  it('shows the guidance share per operation as its own column', () => {
    tagAc(AC(2));
    render(<CostPanelCard data={populated()} />);
    // add_comment is 96,000 of 101,100 characters — 95% guidance. That is the
    // half that is ours to cut, so it belongs in the reader's line of sight.
    expect(screen.getByText(/95%/)).toBeTruthy();
  });
});
