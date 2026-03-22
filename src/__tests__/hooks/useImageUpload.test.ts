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
    expect(result.current.images[0]!.label).toBe('Market Tide');
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

    expect(result.current.images[0]!.label).toBe('Market Tide');
    expect(result.current.images[1]!.label).toBe('Net Flow (SPY)');
  });

  it('respects the 9 image limit', () => {
    const { result } = renderHook(() => useImageUpload());

    for (let i = 0; i < 11; i++) {
      act(() => {
        result.current.addImage(makeFile(`img${i}.png`));
      });
    }

    expect(result.current.images).toHaveLength(9);
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
      target: { files, value: 'C:\\fakepath\\a.png' },
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
});
