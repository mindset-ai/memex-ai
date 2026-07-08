import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  AuxiliaryFilesPanel,
  stageFile,
  isTextFile,
  type StagedFile,
} from './AuxiliaryFilesPanel';

// spec-300 t-6 ac-14: the auxiliary-files panel accepts a BINARY upload (fonts,
// images) and encodes it as base64 for the create payload.
const AC14 = 'mindset-prod/memex-building-itself/specs/spec-300/acs/ac-14';

function binaryFile(name: string, type: string, bytes: number[]): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuxiliaryFilesPanel — binary uploads (ac-14)', () => {
  it('classifies a font/image as binary, a markdown file as text', () => {
    tagAc(AC14);
    expect(isTextFile(binaryFile('logo.png', 'image/png', [137, 80]))).toBe(false);
    expect(isTextFile(new File(['# hi'], 'notes.md', { type: 'text/markdown' }))).toBe(true);
  });

  it('reads a binary file into a base64 payload (ac-14)', async () => {
    tagAc(AC14);
    // A fake 4-byte PNG header.
    const staged = await stageFile(binaryFile('logo.png', 'image/png', [137, 80, 78, 71]));
    expect(staged.binary).toBe(true);
    expect(staged.text).toBeUndefined();
    expect(staged.contentType).toBe('image/png');
    expect(staged.contentBase64).toBeTruthy();
    // The base64 round-trips back to the original bytes.
    const decoded = atob(staged.contentBase64!);
    expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([137, 80, 78, 71]);
  });

  it('accepts a binary file picked in the panel and stages it (ac-14)', async () => {
    tagAc(AC14);
    const onChange = vi.fn();
    render(<AuxiliaryFilesPanel files={[]} onChange={onChange} />);

    const input = screen.getByTestId('aux-file-input') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [binaryFile('brand.woff2', 'font/woff2', [1, 2, 3, 4, 5])] },
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const staged = onChange.mock.calls[0][0] as StagedFile[];
    expect(staged).toHaveLength(1);
    expect(staged[0].path).toBe('brand.woff2');
    expect(staged[0].binary).toBe(true);
    expect(staged[0].contentBase64).toBeTruthy();
  });

  it('renders a staged binary file in the list and can remove it (ac-14)', async () => {
    tagAc(AC14);
    const staged: StagedFile = {
      path: 'brand.woff2',
      contentType: 'font/woff2',
      contentBase64: 'AQIDBAU=',
      size: 5,
      binary: true,
    };
    const onChange = vi.fn();
    render(<AuxiliaryFilesPanel files={[staged]} onChange={onChange} />);

    const row = screen.getByTestId('aux-file-row');
    expect(row).toHaveAttribute('data-binary', 'true');
    expect(row).toHaveTextContent('brand.woff2');

    fireEvent.click(screen.getByLabelText('Remove brand.woff2'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
