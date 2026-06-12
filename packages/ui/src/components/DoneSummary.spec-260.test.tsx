// spec-260 t-6 — the Done seat: the QA report behind a gated button (dec-1),
// modelled on the spec-196 "Read the spec" toggle. Asserts:
//   • the "QA report" button renders only when a build session wrote one;
//   • toggling reveals the read-only report (latest session) and hides it again;
//   • qa_report sections never leak into the "Read the spec" narrative (ac-12's
//     not-plan-prose rule, applied to the done record);
//   • the report body carries no edit affordance (ac-11).

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { DoneSummary } from './DoneSummary';
import type { DocWithGraph } from '../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

const CREATED_AT = '2026-06-02T12:00:00Z';
const COMPLETED_AT = '2026-06-09T12:00:00Z';

function makeDoc(withReport: boolean): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-260',
    title: 'QA report done seat',
    docType: 'spec',
    status: 'done',
    creator: { name: 'Barrie Hadfield', email: 'barrie@mindset.ai' },
    createdAt: CREATED_AT,
    statusChangedAt: COMPLETED_AT,
    sections: [
      {
        id: 's-1',
        sectionType: 'overview',
        title: 'Overview',
        content: 'The plan prose.',
        seq: 1,
        createdAt: CREATED_AT,
        updatedAt: COMPLETED_AT,
      },
      ...(withReport
        ? [
            {
              id: 's-2',
              sectionType: 'qa_report',
              title: 'QA Report',
              content: 'The build session report body.',
              seq: 2,
              createdAt: COMPLETED_AT,
              updatedAt: COMPLETED_AT,
            },
          ]
        : []),
    ],
    decisions: [],
    tasks: [],
  } as unknown as DocWithGraph;
}

function renderDone(withReport: boolean) {
  return render(
    <DoneSummary doc={makeDoc(withReport)} decisions={[]} tasks={[]} acs={[]} issues={[]} />,
  );
}

describe('spec-260 — QA report behind the Done-screen gated button', () => {
  it('ac-12: the gated button reveals the report and hides it again', () => {
    tagAc(AC(12));
    renderDone(true);

    // Gated: nothing shows until the button is pressed.
    const button = screen.getByTestId('done-qa-report');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('done-qa-report-body')).not.toBeInTheDocument();

    fireEvent.click(button);
    const body = screen.getByTestId('done-qa-report-body');
    expect(within(body).getByTestId('qa-report-content')).toHaveTextContent(
      'The build session report body.',
    );

    fireEvent.click(button);
    expect(screen.queryByTestId('done-qa-report-body')).not.toBeInTheDocument();
  });

  it('ac-12: no QA report → no button (the Done screen stays clean)', () => {
    renderDone(false);
    expect(screen.queryByTestId('done-qa-report')).not.toBeInTheDocument();
  });

  it('ac-12: the "Read the spec" narrative excludes qa_report sections', () => {
    tagAc(AC(12));
    renderDone(true);

    fireEvent.click(screen.getByTestId('done-read-spec'));
    const readBody = screen.getByTestId('done-read-spec-body');
    const sections = within(readBody).getAllByTestId('done-read-section');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toHaveTextContent('Overview');
    expect(readBody).not.toHaveTextContent('The build session report body.');
  });

  it('ac-11: the revealed report is read-only — no edit affordance', () => {
    tagAc(AC(11));
    renderDone(true);

    fireEvent.click(screen.getByTestId('done-qa-report'));
    const body = screen.getByTestId('done-qa-report-body');
    expect(body.querySelector('textarea')).toBeNull();
    expect(body.querySelector('input')).toBeNull();
    expect(body.querySelector('[contenteditable="true"]')).toBeNull();
  });
});
