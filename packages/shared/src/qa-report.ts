// spec-260 (dec-1, dec-2): the QA-report section-type vocabulary, shared by the
// server write/read paths and the React UI render seats so the version grammar
// has exactly one source.
//
// A QA report is a `doc_sections` row whose section_type is `qa_report` (the
// first build session) or `qa_report-N` (session N) — the per-doc-unique
// section_type constraint is what makes each session's report a distinct,
// dated, attributed row.

export const QA_REPORT_SECTION_PREFIX = 'qa_report';

// Matches qa_report (version 1) and qa_report-N (version N) — nothing else.
// Deliberately anchored: a LIKE-style prefix match would also catch unrelated
// keys such as `qa_report_notes`.
const QA_REPORT_SECTION_RE = /^qa_report(?:-(\d+))?$/;

/** True if a section_type names a QA report row (any version). */
export function isQaReportSectionType(sectionType: string): boolean {
  return QA_REPORT_SECTION_RE.test(sectionType);
}

/** The 1-based build-session version a qa_report section_type encodes, or null. */
export function qaReportVersion(sectionType: string): number | null {
  const m = QA_REPORT_SECTION_RE.exec(sectionType);
  if (!m) return null;
  return m[1] === undefined ? 1 : Number(m[1]);
}
