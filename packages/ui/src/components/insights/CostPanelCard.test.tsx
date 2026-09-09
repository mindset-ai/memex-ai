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
import { CostPanelCard, MIN_CALLS_FOR_FIGURES, MIN_CALLS_FOR_P90 } from './CostPanelCard';
import { estimateTokens } from './tokenEstimate';
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
    // Headers by role. A text query here passed only because this fixture's
    // rows both clear MIN_CALLS_FOR_P90; dropping one below it would have made
    // the withheld cell's spoken reason a second /p90/i match and reddened
    // this test for a reason that has nothing to do with ac-2 (dec-10).
    expect(screen.getByRole('columnheader', { name: /median/i })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /p90/i })).toBeTruthy();
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

// ─────────────────────────────────────────────────────────────────────────────
// dec-10 (t-7) — the P90 floor.
//
// Observed on prod 2026-09-09: ten of twelve rows carried n=1, and every one
// still printed a MEDIAN and a P90. At n=1 those are the same observation under
// two headers; at n=2 the p90 is `percentile_cont` interpolating 90% of the way
// between the only two calls seen. Below n=10 no observation actually sits in
// the top decile, so the cell claims a tail it has not observed.
//
// THE FIXTURE IS DERIVED FROM THE CONSTANT, NOT FROM 10 (ac-25). A test that
// hardcoded 9 would, the day someone raises the floor to 30, silently start
// asserting the ABOVE-floor case twice and prove nothing about suppression —
// green, for the wrong reason. Reading the constant re-aims it instead.
// ─────────────────────────────────────────────────────────────────────────────

/** The card's own arithmetic, so the expectation cannot drift from it. */
const approx = (chars: number): string =>
  `≈ ${estimateTokens(chars).toLocaleString('en-US')}`;

/**
 * One payload, both sides of the floor. Deliberately ONE fixture rather than
 * two: a regression that blanks EVERY p90 must fail, and it would pass a
 * suppression-only test (ac-24 is the other half of ac-23).
 */
function acrossTheFloor(): CostPanelResponse {
  return {
    available: true,
    windowDays: 30,
    totals: { calls: 2 * MIN_CALLS_FOR_P90 - 1, totalChars: 300_000, guidanceChars: 90_000 },
    operations: [
      {
        // AT the floor — the p90 renders.
        tool: 'get_doc',
        verb: null,
        calls: MIN_CALLS_FOR_P90,
        medianChars: 2_000,
        p90Chars: 888_888,
        guidanceChars: 60_000,
        totalChars: 200_000,
      },
      {
        // ONE BELOW the floor — the p90 is withheld, the median is not.
        tool: 'update_doc',
        verb: null,
        calls: MIN_CALLS_FOR_P90 - 1,
        medianChars: 1_000,
        p90Chars: 999_999,
        guidanceChars: 30_000,
        totalChars: 100_000,
      },
    ],
  };
}

describe('CostPanelCard — dec-10: a row too thin for a percentile', () => {
  it('withholds the p90 on a row below the floor while still showing its median', () => {
    tagAc(AC(23));
    render(<CostPanelCard data={acrossTheFloor()} />);

    // The thin row is present and its median — meaningful at any n, because it
    // IS the value — still renders with its exact character count beside it.
    expect(screen.getByText('update_doc')).toBeTruthy();
    expect(screen.getByText(approx(1_000))).toBeTruthy();
    expect(screen.getByText('1,000 ch')).toBeTruthy();

    // But its p90 figure is nowhere on the card. 999,999 characters is a value
    // no other cell in this fixture can produce, so this cannot pass by
    // coincidence.
    expect(screen.queryByText(approx(999_999))).toBeNull();
  });

  it('still renders the p90 on a row at the floor — a threshold, not a removal', () => {
    tagAc(AC(24));
    render(<CostPanelCard data={acrossTheFloor()} />);

    expect(screen.getByText(approx(888_888))).toBeTruthy();
    // And the column itself survives: ac-2 committed to a median AND a p90.
    // By ROLE, not by text: the withheld cell's spoken reason also contains
    // "p90", so a text query matches two nodes and throws. The claim was
    // always about the HEADER anyway.
    expect(screen.getByRole('columnheader', { name: /p90/i })).toBeTruthy();
  });

  it('derives the floor from the exported constant rather than a literal', () => {
    tagAc(AC(25));
    // The constant is what the card reads, so the card and this test cannot
    // disagree about where the threshold is. Asserted as a property of the
    // fixture: exactly one row sits below it and one at it.
    const { operations } = acrossTheFloor() as Extract<
      CostPanelResponse,
      { available: true }
    >;
    expect(operations.filter((o) => o.calls < MIN_CALLS_FOR_P90)).toHaveLength(1);
    expect(operations.filter((o) => o.calls >= MIN_CALLS_FOR_P90)).toHaveLength(1);
    // A floor at or below the panel's own gate would be inert: every row that
    // reaches the table would clear it, and nothing would ever be suppressed.
    expect(MIN_CALLS_FOR_P90).toBeGreaterThan(MIN_CALLS_FOR_FIGURES);
  });

  it('says why the cell is empty rather than leaving a silent blank', () => {
    tagAc(AC(27));
    render(<CostPanelCard data={acrossTheFloor()} />);
    // A bare <td> announces nothing to a screen reader, and "missing" and
    // "deliberately withheld" are the same experience. The reason is text.
    const reason = screen.getByText(/too few calls/i);
    expect(reason).toBeTruthy();

    // The string being in the DOM is NOT the claim — testing-library ignores
    // CSS, so `getByText` would find it inside an aria-hidden subtree just as
    // happily. What ac-27 promises is that a screen reader REACHES it, so
    // assert the two halves carry opposite visibility: the reason is spoken and
    // the dash is not. Without this the test passes on markup no reader hears.
    expect(reason.closest('[aria-hidden="true"]')).toBeNull();
    const dash = screen.getByText('—');
    expect(dash.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws no p90 column at all when NO row clears the floor', () => {
    tagAc(AC(28));
    // The state a young Memex actually lives in: enough total calls for the
    // panel to show figures, no single operation near the floor. This is the
    // dogfood card as measured on prod 2026-09-09 — twelve operations, the
    // busiest at n=2 — where a p90 header would have stood over twelve em
    // dashes for weeks.
    const allThin: CostPanelResponse = {
      available: true,
      windowDays: 30,
      totals: { calls: 3, totalChars: 30_000, guidanceChars: 9_000 },
      operations: [1, 1, 1].map((calls, i) => ({
        tool: `thin_tool_${i}`,
        verb: null,
        calls,
        medianChars: 10_000,
        p90Chars: 10_000,
        guidanceChars: 3_000,
        totalChars: 10_000,
      })),
    };
    render(<CostPanelCard data={allThin} />);

    // The table is drawn — this is not the not-enough-activity state.
    expect(screen.getByRole('columnheader', { name: /median/i })).toBeTruthy();
    expect(screen.getByText('thin_tool_0')).toBeTruthy();

    // But no p90 header, and no withheld-cell dashes either: an absent column
    // needs no per-row apology.
    expect(screen.queryByRole('columnheader', { name: /p90/i })).toBeNull();
    expect(screen.queryByText(/too few calls/i)).toBeNull();
  });

  it('brings the column back as soon as one row earns it', () => {
    tagAc(AC(28));
    // The other direction, because a gate that never opens is the same bug as
    // one that never closes. `acrossTheFloor` has exactly one qualifying row.
    render(<CostPanelCard data={acrossTheFloor()} />);
    expect(screen.getByRole('columnheader', { name: /p90/i })).toBeTruthy();
    // And the thin row beside it is withheld rather than dropped from view.
    expect(screen.getByText('update_doc')).toBeTruthy();
    expect(screen.getByText(/too few calls/i)).toBeTruthy();
  });
});
