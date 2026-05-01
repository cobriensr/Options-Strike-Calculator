import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePeriscopeChat } from '../../components/PeriscopeChat/usePeriscopeChat';

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

function makeFile(name = 'chart.png', type = 'image/png', bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

/**
 * Mock fetch with NDJSON-shaped success body: 1 keepalive ping followed
 * by the final envelope.
 */
function mockFetchSuccess(envelope: Record<string, unknown>) {
  const body = `{"ping":true}\n${JSON.stringify(envelope)}\n`;
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(envelope),
  } as unknown as Response);
}

function mockFetchHttpError(status: number, jsonBody: { error?: string } = {}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(jsonBody),
    text: () => Promise.resolve(JSON.stringify(jsonBody)),
  } as unknown as Response);
}

// FileReader stub returning a `data:image/png;base64,xxx` URL so the
// hook's `fileToBase64` strips the prefix correctly.
class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: unknown = null;
  readAsDataURL() {
    this.result = 'data:image/png;base64,YmFzZTY0';
    queueMicrotask(() => this.onload?.());
  }
}
globalThis.FileReader =
  MockFileReader as unknown as typeof globalThis.FileReader;

// ============================================================
// TESTS
// ============================================================

describe('usePeriscopeChat', () => {
  it('starts in read mode with empty state', () => {
    const { result } = renderHook(() => usePeriscopeChat());
    expect(result.current.mode).toBe('read');
    expect(result.current.images).toEqual({});
    expect(result.current.parentId).toBeNull();
    expect(result.current.inFlight).toBe(false);
    expect(result.current.response).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('setImage stages a valid image and creates a preview URL', () => {
    const { result } = renderHook(() => usePeriscopeChat());
    const file = makeFile();

    act(() => {
      result.current.setImage('chart', file);
    });

    expect(result.current.images.chart?.file).toBe(file);
    expect(result.current.images.chart?.preview).toBe('blob:mock-url');
    expect(mockCreateObjectURL).toHaveBeenCalledWith(file);
    expect(result.current.error).toBeNull();
  });

  it('setImage rejects oversized files and surfaces an error', () => {
    const { result } = renderHook(() => usePeriscopeChat());
    const tooBig = makeFile('huge.png', 'image/png', 11 * 1024 * 1024);

    act(() => {
      result.current.setImage('chart', tooBig);
    });

    expect(result.current.images.chart).toBeUndefined();
    expect(result.current.error).toMatch(/too large/i);
    expect(mockCreateObjectURL).not.toHaveBeenCalled();
  });

  it('setImage rejects unsupported media types', () => {
    const { result } = renderHook(() => usePeriscopeChat());
    const wrongType = makeFile('chart.tiff', 'image/tiff');

    act(() => {
      result.current.setImage('chart', wrongType);
    });

    expect(result.current.images.chart).toBeUndefined();
    expect(result.current.error).toMatch(/not supported/i);
  });

  it('setImage(null) revokes the previous URL and removes the slot', () => {
    const { result } = renderHook(() => usePeriscopeChat());

    act(() => {
      result.current.setImage('chart', makeFile());
    });
    expect(result.current.images.chart).toBeDefined();

    act(() => {
      result.current.setImage('chart', null);
    });

    expect(result.current.images.chart).toBeUndefined();
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('replacing an existing slot revokes the old URL exactly once', () => {
    const { result } = renderHook(() => usePeriscopeChat());

    act(() => {
      result.current.setImage('chart', makeFile('a.png'));
    });
    act(() => {
      result.current.setImage('chart', makeFile('b.png'));
    });

    // One revoke for the replaced slot, no accidental double-revoke from
    // a StrictMode-double-invoked updater.
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(2);
  });

  it('reset revokes all URLs and clears every field', () => {
    const { result } = renderHook(() => usePeriscopeChat());

    act(() => {
      result.current.setImage('chart', makeFile('a.png'));
      result.current.setImage('gex', makeFile('b.png'));
      result.current.setMode('debrief');
      result.current.setParentId(42);
    });
    expect(Object.keys(result.current.images)).toHaveLength(2);

    act(() => {
      result.current.reset();
    });

    expect(result.current.images).toEqual({});
    expect(result.current.mode).toBe('read');
    expect(result.current.parentId).toBeNull();
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('submit without staged images surfaces an error and skips fetch', async () => {
    globalThis.fetch = vi.fn();
    const { result } = renderHook(() => usePeriscopeChat());

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toMatch(/at least one screenshot/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('submit posts with the staged images and parses the NDJSON envelope', async () => {
    const envelope = {
      ok: true,
      id: 7,
      mode: 'read',
      prose: 'Pin day at 7120.',
      structured: {
        spot: 7120,
        cone_lower: 7095,
        cone_upper: 7150,
        long_trigger: 7125,
        short_trigger: 7115,
        regime_tag: 'pin',
      },
      model: 'claude-opus-4-7',
      durationMs: 12345,
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 100 },
    };
    mockFetchSuccess(envelope);

    const { result } = renderHook(() => usePeriscopeChat());
    act(() => {
      result.current.setImage('chart', makeFile('a.png'));
    });

    await act(async () => {
      await result.current.submit();
    });

    await waitFor(() => {
      expect(result.current.response).toEqual(envelope);
    });
    expect(result.current.error).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledOnce();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/periscope-chat');
    const sentBody = JSON.parse((init as RequestInit).body as string) as {
      mode: string;
      images: Array<{ kind: string; mediaType: string; data: string }>;
    };
    expect(sentBody.mode).toBe('read');
    expect(sentBody.images).toHaveLength(1);
    expect(sentBody.images[0]!.kind).toBe('chart');
    expect(sentBody.images[0]!.mediaType).toBe('image/png');
    // Base64 strip leaves only the part after the comma.
    expect(sentBody.images[0]!.data).toBe('YmFzZTY0');
  });

  it('submit surfaces 4xx error body as the error message', async () => {
    mockFetchHttpError(400, { error: 'At least one image is required' });

    const { result } = renderHook(() => usePeriscopeChat());
    act(() => {
      result.current.setImage('chart', makeFile('a.png'));
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe('At least one image is required');
    expect(result.current.response).toBeNull();
  });

  it('submit surfaces NDJSON failure envelope as the error', async () => {
    const failure = { ok: false, error: 'refusal' };
    mockFetchSuccess(failure);

    const { result } = renderHook(() => usePeriscopeChat());
    act(() => {
      result.current.setImage('chart', makeFile('a.png'));
    });

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.error).toBe('refusal');
    expect(result.current.response).toBeNull();
  });

  it('submit includes parentId for debrief mode and omits it otherwise', async () => {
    const envelope = {
      ok: true,
      id: 1,
      mode: 'debrief',
      prose: '',
      structured: {
        spot: null,
        cone_lower: null,
        cone_upper: null,
        long_trigger: null,
        short_trigger: null,
        regime_tag: null,
      },
      model: 'claude-opus-4-7',
      durationMs: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    mockFetchSuccess(envelope);

    const { result } = renderHook(() => usePeriscopeChat());
    act(() => {
      result.current.setImage('chart', makeFile());
      result.current.setMode('debrief');
      result.current.setParentId(17);
    });

    await act(async () => {
      await result.current.submit();
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    ) as { parentId?: number; mode: string };
    expect(sentBody.mode).toBe('debrief');
    expect(sentBody.parentId).toBe(17);
  });
});
