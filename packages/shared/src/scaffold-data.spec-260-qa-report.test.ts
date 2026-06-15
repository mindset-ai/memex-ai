// spec-260 t-5 — the QA-report generation instruction in the build handoff.
//
// The build agent's STEP-5 closing summary used to evaporate into chat; spec-260
// persists it as a versioned `qa_report` section written at the build→verify
// hand-off (dec-2), grounded in the session's real changes (dec-3). These tests
// pin the prompt contract:
//
//   ac-13 — the hand-off prompt itself instructs the agent to write the report as
//           part of build completion (not a separate manual action).
//   ac-15 — the generation prompt REQUIRES grounding: FE/BE sections in the
//           session's actual code changes, the testing section in the tests run +
//           test_events emitted, cross-referenced to ACs.
//   ac-16 — the generation prompt is VCS-agnostic per std-22: no version-control
//           literal; it says "the changes you made this session".
//
// House style: dependency-free assertions over the scaffold dataset.

import { describe, expect, it } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD, QA_REPORT_GENERATION_INSTRUCTION } from './scaffold-data.js';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-260/acs/ac-${n}`;

const handoff = BASE_SCAFFOLD.promptButtons.find((b) => b.id === 'opening-build-handoff');

describe('spec-260: QA-report generation instruction (build handoff STEP 6)', () => {
  it('ac-13: the build hand-off prompt instructs persisting the QA report as part of build completion', () => {
    tagAc(AC(13));
    expect(handoff, 'opening-build-handoff node must exist').toBeDefined();
    // The generation instruction ships inside the hand-off prompt itself…
    expect(handoff!.text).toContain('persist the QA Report');
    expect(handoff!.text).toContain(QA_REPORT_GENERATION_INSTRUCTION);
    // …as part of completing build, not a separate manual action.
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('write_qa_report');
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain(
      'IS part of completing build, not a separate request',
    );
    // The chat-driven agent path (the essence footer) carries the same directive.
    expect(handoff!.essence).toContain('write_qa_report');
  });

  it('ac-13: each session appends a distinct version — the prompt forbids overwriting prior reports', () => {
    tagAc(AC(13));
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('appended as a new dated version');
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('never overwrites');
  });

  it('ac-15: grounding is mandatory — FE/BE from the session\'s actual changes, testing from tests run + emitted test events, cross-referenced to ACs', () => {
    tagAc(AC(15));
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('GROUNDING IS MANDATORY');
    // FE/BE sections grounded in the session's actual changes…
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain(
      'base sections 1–2 on the changes you made this session',
    );
    // …and the testing section in what actually ran + what was emitted, tied to ACs.
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('tests you actually ran');
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('test events you emitted');
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain(
      'cross-referenced to their acceptance criteria',
    );
    // A report is a record of the session, never a re-statement of the plan.
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('never a restatement of the plan');
  });

  it('ac-15: the report structure covers all eight reviewer-facing parts', () => {
    tagAc(AC(15));
    for (const part of [
      'Front-end / user-affecting changes',
      'Back-end changes',
      'Testing created and run',
      'Known gaps & follow-ups',
      'Deviations from the plan',
      'Dependencies & integration points',
      'Migration / deployment notes',
      'Open questions',
    ]) {
      expect(QA_REPORT_GENERATION_INSTRUCTION, `missing report part: ${part}`).toContain(part);
    }
    // Gaps/follow-ups ride register_issue todos so an incomplete build is never
    // read as complete (dec-3: issues, not the legacy question comment type).
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain("register_issue({ type: 'todo' })");
  });

  it('ac-16: the generation prompt is VCS-agnostic per std-22 — no version-control literal, "the changes you made this session"', () => {
    tagAc(AC(16));
    // No version-control-specific literal anywhere in the generation prompt.
    expect(QA_REPORT_GENERATION_INSTRUCTION).not.toMatch(/\bgit\b/i);
    expect(QA_REPORT_GENERATION_INSTRUCTION).not.toMatch(/\bgit diff\b/i);
    expect(QA_REPORT_GENERATION_INSTRUCTION).not.toMatch(/\b(svn|mercurial|version control)\b/i);
    expect(QA_REPORT_GENERATION_INSTRUCTION).not.toMatch(/\bcommit(s|ted)?\b/i);
    expect(QA_REPORT_GENERATION_INSTRUCTION).not.toMatch(/\bworking[- ]tree\b/i);
    // The portable phrasing dec-3 mandates.
    expect(QA_REPORT_GENERATION_INSTRUCTION).toContain('the changes you made this session');
  });
});
