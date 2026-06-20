// spec-318 t-11 (ac-17): the hook applies the derived title to document.title.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useDocumentTitle } from './useDocumentTitle';
import type { DocumentTitleInput } from '../utils/documentTitle';

function Probe({ input }: { input: DocumentTitleInput }) {
  useDocumentTitle(input);
  return null;
}

afterEach(cleanup);

describe('useDocumentTitle', () => {
  it('sets a handle-first title for a Spec page', () => {
    render(<Probe input={{ kind: 'spec', handle: 'spec-318', name: 'Desktop tabs' }} />);
    expect(document.title).toBe('spec-318 · Desktop tabs');
  });

  it('sets the PageHeader title for a normal page', () => {
    render(<Probe input={{ kind: 'page', title: 'Settings' }} />);
    expect(document.title).toBe('Settings');
  });

  it('re-applies the title when the input changes', () => {
    const { rerender } = render(<Probe input={{ kind: 'page', title: 'Issues' }} />);
    expect(document.title).toBe('Issues');
    rerender(<Probe input={{ kind: 'page', title: 'Decisions' }} />);
    expect(document.title).toBe('Decisions');
  });

  it('leaves the current title untouched when there is nothing to set', () => {
    document.title = 'Preserved';
    render(<Probe input={{ kind: 'page', title: '   ' }} />);
    expect(document.title).toBe('Preserved');
  });
});
