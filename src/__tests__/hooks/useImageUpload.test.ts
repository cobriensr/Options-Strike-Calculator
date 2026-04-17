import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImageUpload } from '../../hooks/useImageUpload';

// ============================================================
// MOCKS
// ============================================================

const mockCreateObjectURL = vi.fn(() => 'blob:mock-url');
const mockRevokeObjectURL = vi.fn();

beforeEach(() => {
  globalThis.URL.createObjectURL = mockCreateObjectURL;
  globalThis.URL.revokeObjectURL = mockRevokeObjectURL;
  vi.clearAllMocks();
});

function makeFile(name = 'chart.png', type = 'image/png'): File {
  return new File(['data'], name, { type });
}

// ============================================================
// TESTS
// ============================================================

describe('useImageUpload', () => {
  // ── Initial state ──

  it('starts with an empty images array and defined refs', () => {
    const { result } = renderHook(() => useImageUpload());
    expect(result.current.images).toEqual([]);
    expect(result.current.fileInputRef).toBeDefined();
    expect(result.current.replaceInputRef).toBeDefined();
  });

  // ── addImage ──

  it('adds an image with a generated preview URL and auto-assigned label', () => {
    const { result } = renderHook(() => useImageUpload());
    const file = makeFile();

    act(() => {
      result.current.addImage(file);
    });

    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.file).toBe(file);
    expect(result.current.images[0]!.preview).toBe('blob:mock-url');
    expect(result.current.images[0]!.label).toBe('Periscope (Gamma)');
    expect(result.current.images[0]!.id).toMatch(/^img-/);
    expect(mockCreateObjectURL).toHaveBeenCalledWith(file);
  });

  it('auto-assigns the next unused label for subsequent images', () => {
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile('a.png'));
    });
    act(() => {
      result.current.addImage(makeFile('b.png'));
    });

    expect(result.current.images[0]!.label).toBe('Periscope (Gamma)');
    expect(result.current.images[1]!.label).toBe('Periscope Charm (SPX)');
  });

  it('respects the 4 image limit', () => {
    const { result } = renderHook(() => useImageUpload());

    for (let i = 0; i < 6; i++) {
      act(() => {
        result.current.addImage(makeFile(`img${i}.png`));
      });
    }

    expect(result.current.images).toHaveLength(4);
  });

  // ── removeImage ──

  it('removes an image by id and revokes its object URL', () => {
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile());
    });

    const id = result.current.images[0]!.id;

    act(() => {
      result.current.removeImage(id);
    });

    expect(result.current.images).toHaveLength(0);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  // ── clearAllImages ──

  it('clears all images and revokes all object URLs', () => {
    let urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => `blob:url-${++urlCounter}`);

    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile('a.png'));
    });
    act(() => {
      result.current.addImage(makeFile('b.png'));
    });

    expect(result.current.images).toHaveLength(2);

    act(() => {
      result.current.clearAllImages();
    });

    expect(result.current.images).toHaveLength(0);
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:url-1');
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:url-2');
  });

  // ── updateLabel ──

  it('updates the label for a specific image', () => {
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile());
    });

    const id = result.current.images[0]!.id;

    act(() => {
      result.current.updateLabel(id, 'Periscope (Delta Flow)');
    });

    expect(result.current.images[0]!.label).toBe('Periscope (Delta Flow)');
  });

  // ── handleFileSelect ──

  it('adds files from an input change event', () => {
    const { result } = renderHook(() => useImageUpload());

    const files = [makeFile('a.png'), makeFile('b.png')];
    const event = {
      target: { files, value: String.raw`C:\fakepath\a.png` },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleFileSelect(event);
    });

    expect(result.current.images).toHaveLength(2);
  });

  // ── handleDrop ──

  it('adds image files from a drag event and ignores non-images', () => {
    const { result } = renderHook(() => useImageUpload());

    const imageFile = makeFile('chart.png', 'image/png');
    const textFile = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const jpegFile = makeFile('photo.jpg', 'image/jpeg');

    const event = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [imageFile, textFile, jpegFile],
      },
    } as unknown as React.DragEvent;

    act(() => {
      result.current.handleDrop(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(result.current.images).toHaveLength(2);
    expect(result.current.images[0]!.file).toBe(imageFile);
    expect(result.current.images[1]!.file).toBe(jpegFile);
  });

  // ── Paste listener ──

  it('adds an image when a paste event contains an image clipboard item', () => {
    const { result } = renderHook(() => useImageUpload());

    const pastedFile = makeFile('pasted.png', 'image/png');
    const pasteEvent = new Event('paste', {
      bubbles: true,
    }) as unknown as ClipboardEvent;

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => pastedFile,
          },
        ],
      },
    });

    // Spy on preventDefault
    const preventDefaultSpy = vi.fn();
    Object.defineProperty(pasteEvent, 'preventDefault', {
      value: preventDefaultSpy,
    });

    act(() => {
      document.dispatchEvent(pasteEvent);
    });

    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.file).toBe(pastedFile);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  // ── replaceImage + handleReplaceFile ──

  it('handleReplaceFile does nothing when no file is selected', () => {
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile('original.png'));
    });

    // Call replaceImage to set replaceTargetIndex
    act(() => {
      result.current.replaceImage(1);
    });

    // Call handleReplaceFile with an empty files list
    const emptyEvent = {
      target: { files: [] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleReplaceFile(emptyEvent);
    });

    // Image should be unchanged
    expect(result.current.images).toHaveLength(1);
  });

  it('handleReplaceFile does nothing when replaceTargetIndex is null', () => {
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile('original.png'));
    });

    // Do NOT call replaceImage — replaceTargetIndex stays null
    const file = makeFile('new.png');
    const event = {
      target: { files: [file] },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleReplaceFile(event);
    });

    // Image should be unchanged (early return because replaceTargetIndex is null)
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.file.name).toBe('original.png');
  });

  it('handleReplaceFile replaces the target image at the correct index', () => {
    let urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => `blob:url-${++urlCounter}`);

    const { result } = renderHook(() => useImageUpload());

    // Add two images
    act(() => {
      result.current.addImage(makeFile('first.png'));
    });
    act(() => {
      result.current.addImage(makeFile('second.png'));
    });

    const firstId = result.current.images[0]!.id;
    const secondId = result.current.images[1]!.id;

    // Replace the second image (index 2 = 1-based)
    act(() => {
      result.current.replaceImage(2);
    });

    const replacementFile = makeFile('replacement.png');
    const event = {
      target: { files: [replacementFile], value: '' },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleReplaceFile(event);
    });

    expect(result.current.images).toHaveLength(2);
    // First image unchanged
    expect(result.current.images[0]!.id).toBe(firstId);
    // Second image replaced with new file
    expect(result.current.images[1]!.id).not.toBe(secondId);
    expect(result.current.images[1]!.file.name).toBe('replacement.png');
    // Old preview URL was revoked
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:url-2');
  });

  it('ignores paste events without image items', () => {
    const { result } = renderHook(() => useImageUpload());

    const pasteEvent = new Event('paste', {
      bubbles: true,
    }) as unknown as ClipboardEvent;

    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            type: 'text/plain',
            getAsFile: () => null,
          },
        ],
      },
    });

    act(() => {
      document.dispatchEvent(pasteEvent);
    });

    expect(result.current.images).toHaveLength(0);
  });

  // ── Additional branch coverage ──

  it('handleReplaceFile no-ops when replaceTargetIndex is out of bounds', () => {
    const { result } = renderHook(() => useImageUpload());

    // Add a single image.
    act(() => {
      result.current.addImage(makeFile('only.png'));
    });

    // Request replace at index 9 (1-based → targetIdx=8, far out of bounds).
    act(() => {
      result.current.replaceImage(9);
    });

    const file = makeFile('new.png');
    const event = {
      target: { files: [file], value: '' },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    mockRevokeObjectURL.mockClear();
    act(() => {
      result.current.handleReplaceFile(event);
    });

    // Original image untouched — out-of-bounds early return took the prev path.
    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.file.name).toBe('only.png');
    // No URL revocation (since replacement never happened).
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();
  });

  it('handleReplaceFile no-ops when replaceTargetIndex is zero (targetIdx=-1)', () => {
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImage(makeFile('only.png'));
    });

    // replaceImage(0) → targetIdx = -1, triggers the < 0 branch.
    act(() => {
      result.current.replaceImage(0);
    });

    const file = makeFile('new.png');
    const event = {
      target: { files: [file], value: '' },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleReplaceFile(event);
    });

    expect(result.current.images).toHaveLength(1);
    expect(result.current.images[0]!.file.name).toBe('only.png');
  });

  it('handleFileSelect handles null files list gracefully', () => {
    const { result } = renderHook(() => useImageUpload());

    // e.target.files can be null on some browsers/events.
    const event = {
      target: { files: null, value: '' },
    } as unknown as React.ChangeEvent<HTMLInputElement>;

    act(() => {
      result.current.handleFileSelect(event);
    });

    // No image added; no crash.
    expect(result.current.images).toEqual([]);
  });

  it('ignores paste events with no clipboardData', () => {
    const { result } = renderHook(() => useImageUpload());

    const pasteEvent = new Event('paste', {
      bubbles: true,
    }) as unknown as ClipboardEvent;

    Object.defineProperty(pasteEvent, 'clipboardData', { value: null });

    act(() => {
      document.dispatchEvent(pasteEvent);
    });

    // Array.from(undefined ?? []) -> empty; no image added.
    expect(result.current.images).toEqual([]);
  });

  it('ignores paste image items whose getAsFile returns null', () => {
    const { result } = renderHook(() => useImageUpload());

    const pasteEvent = new Event('paste', {
      bubbles: true,
    }) as unknown as ClipboardEvent;

    const preventDefaultSpy = vi.fn();
    Object.defineProperty(pasteEvent, 'preventDefault', {
      value: preventDefaultSpy,
    });

    // Image type but getAsFile yields null — the `if (file)` branch falls through.
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => null,
          },
        ],
      },
    });

    act(() => {
      document.dispatchEvent(pasteEvent);
    });

    // preventDefault fired (type matched), but no image was added.
    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(result.current.images).toEqual([]);
  });
});
