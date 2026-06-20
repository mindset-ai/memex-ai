// Unit tests for the central document.title derivation (spec-318 t-11, ac-17).
// UNTAGGED — pure-function checks. The desktop tab-chip consumer reads
// document.title; the hook that applies these strings is exercised in
// useDocumentTitle.test.tsx.

import { describe, it, expect } from 'vitest';
import { deriveDocumentTitle } from './documentTitle';

describe('deriveDocumentTitle', () => {
  it('puts the Spec handle FIRST so the unique id survives truncation', () => {
    expect(
      deriveDocumentTitle({ kind: 'spec', handle: 'spec-318', name: 'Desktop tabs' }),
    ).toBe('spec-318 · Desktop tabs');
  });

  it('keeps the full spec name un-truncated (truncation is the consumer concern)', () => {
    const name = 'A very long spec name that a narrow tab chip would have to clip';
    expect(deriveDocumentTitle({ kind: 'spec', handle: 'spec-7', name })).toBe(
      `spec-7 · ${name}`,
    );
  });

  it('falls back to just the handle when a Spec has no name yet', () => {
    expect(deriveDocumentTitle({ kind: 'spec', handle: 'spec-9', name: '' })).toBe(
      'spec-9',
    );
    expect(
      deriveDocumentTitle({ kind: 'spec', handle: 'spec-9', name: '   ' }),
    ).toBe('spec-9');
  });

  it('derives a normal page title from the PageHeader title', () => {
    expect(deriveDocumentTitle({ kind: 'page', title: 'Settings' })).toBe('Settings');
    expect(deriveDocumentTitle({ kind: 'page', title: 'Decisions' })).toBe(
      'Decisions',
    );
  });

  it('trims a page title and ignores empty ones (keeps the existing title)', () => {
    expect(deriveDocumentTitle({ kind: 'page', title: '  Issues  ' })).toBe('Issues');
    expect(deriveDocumentTitle({ kind: 'page', title: '' })).toBeNull();
    expect(deriveDocumentTitle({ kind: 'page', title: '   ' })).toBeNull();
  });
});
