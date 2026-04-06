import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChartAnalysis } from '../../hooks/useChartAnalysis';
import { THINKING_MESSAGES } from '../../constants';
import type {
  AnalysisMode,
  UploadedImage,
} from '../../components/ChartAnalysis/types';

// ============================================================
// MOCKS
// ============================================================

const originalFetch = globalThis.fetch;
const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch;
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mockFile = new File(['data'], 'chart.png', { type: 'image/png' });
// Provide a working arrayBuffer so the hook can convert to base64
Object.defineProperty(mockFile, 'arrayBuffer', {
  value: () => Promise.resolve(new ArrayBuffer(4)),
  configurable: true,
});

const defaultImages: UploadedImage[] = [
  { id: '1', file: mockFile, preview: 'blob:url', label: 'Periscope (Gamma)' },
];

function defaultOpts(overrides: Record<string, unknown> = {}) {
  return {
    images: defaultImages,
    context: { selectedDate: '2025-01-15' },
    results: null,
    mode: 'entry' as AnalysisMode,
    ...overrides,
  };
}

const sampleAnalysis = {
  mode: 'entry' as const,
  structure: 'Iron Condor',
  confidence: 'high',
  suggestedDelta: 8,
  reasoning: 'Strong support',
  observations: ['Bullish flow'],
  risks: ['Gap risk'],
  structureRationale: 'Wide range day',
};

function makeSuccessResponse(analysis = sampleAnalysis) {
  // The endpoint returns NDJSON: keepalive pings + final JSON line.
  // The hook reads via res.text() and parses the last line.
  const ndjson =
    JSON.stringify({ ping: true }) + '\n' + JSON.stringify({ analysis }) + '\n';
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(ndjson),
  };
}

function makeErrorResponse(error: string, status = 400) {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify({ error }) + '\n'),
  };
}

// ============================================================
// TESTS
// ============================================================

describe('useChartAnalysis', () => {
  // ── Initial state ──

  it('returns correct initial state', () => {
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    expect(result.current.analysis).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.elapsed).toBe(0);
    expect(result.current.rawResponse).toBeNull();
    expect(result.current.lastAnalysis).toBeNull();
    expect(result.current.retryPrompt).toBeNull();
  });

  // ── Returns THINKING_MESSAGES ──

  it('returns the THINKING_MESSAGES array', () => {
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));
    expect(result.current.THINKING_MESSAGES).toBe(THINKING_MESSAGES);
    expect(result.current.THINKING_MESSAGES.length).toBeGreaterThan(0);
  });

  // ── analyze: sets loading and calls fetch ──

  it('sets loading to true and calls fetch with correct payload', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse());

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    await act(async () => {
      await result.current.analyze();
    });

    // fetch was called for /api/analyze
    const analyzeCalls = mockFetch.mock.calls.filter(
      (call) => call[0] === '/api/analyze',
    );
    expect(analyzeCalls.length).toBe(1);

    const [url, options] = analyzeCalls[0]!;
    expect(url).toBe('/api/analyze');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.images).toHaveLength(1);
    expect(body.images[0].label).toBe('Periscope (Gamma)');
    expect(body.context.mode).toBe('entry');
    expect(body.context.selectedDate).toBe('2025-01-15');
  });

  // ── analyze: on success ──

  it('sets analysis result and calls onAnalysisSaved on success', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse());

    const onAnalysisSaved = vi.fn();
    const { result } = renderHook(() =>
      useChartAnalysis(defaultOpts({ onAnalysisSaved })),
    );

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.analysis).toEqual(sampleAnalysis);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(onAnalysisSaved).toHaveBeenCalledOnce();
  });

  // ── analyze: fatal HTTP error (4xx) ──

  it('sets error immediately on fatal (4xx) error', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Bad request', 400));

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.error).toBe('Bad request');
    expect(result.current.analysis).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.retryPrompt).toBeNull();
  });

  // ── analyze: does not retry 4xx errors ──

  it('does not retry on 4xx client errors', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Unauthorized', 401));

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    await act(async () => {
      await result.current.analyze();
    });

    // Should only be called once (no retries for client errors)
    const analyzeCalls = mockFetch.mock.calls.filter(
      (call) => call[0] === '/api/analyze',
    );
    expect(analyzeCalls.length).toBe(1);
    expect(result.current.error).toBe('Unauthorized');
  });

  // ── cancelAnalysis ──

  it('aborts the request and sets error to "Analysis cancelled."', async () => {
    // Use fake timers so we can control the flow precisely
    vi.useFakeTimers();

    // Make fetch hang until aborted
    mockFetch.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        });
      },
    );

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    // Start the analysis without awaiting
    let analyzePromise: Promise<void> | undefined;
    act(() => {
      analyzePromise = result.current.analyze();
    });

    // Allow microtasks (arrayBuffer, etc.) to flush
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    // Cancel while loading
    act(() => {
      result.current.cancelAnalysis();
    });

    // Flush all pending microtasks and timers
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Await the analyze promise to fully settle
    await act(async () => {
      await analyzePromise;
    });

    expect(result.current.error).toBe('Analysis cancelled.');
    expect(result.current.loading).toBe(false);
  });

  // ── onModeCompleted callback ──

  it('calls onModeCompleted with the correct mode on success', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse());

    const onModeCompleted = vi.fn();
    const { result } = renderHook(() =>
      useChartAnalysis(defaultOpts({ onModeCompleted, mode: 'midday' })),
    );

    await act(async () => {
      await result.current.analyze();
    });

    expect(onModeCompleted).toHaveBeenCalledWith('midday');
  });

  // ── elapsed timer ──

  it('increments elapsed timer while loading', async () => {
    vi.useFakeTimers();

    // Make fetch hang so loading stays true
    mockFetch.mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    );

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    // Start analysis
    act(() => {
      result.current.analyze();
    });

    // Advance time to allow the loading state to be set and microtasks to run
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.elapsed).toBe(0);

    // Advance 1 second
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(result.current.elapsed).toBe(1);

    // Advance 2 more seconds
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.elapsed).toBe(3);
  });

  // ── lastAnalysis reflects most recent success ──

  it('lastAnalysis reflects the most recent successful analysis', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse());

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.lastAnalysis).toEqual(sampleAnalysis);
  });

  // ── does not analyze with empty images ──

  it('does not call fetch when images array is empty', async () => {
    const { result } = renderHook(() =>
      useChartAnalysis(defaultOpts({ images: [] })),
    );

    await act(async () => {
      await result.current.analyze();
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });
});

// ============================================================
// RETRY PROMPT
// ============================================================

describe('useChartAnalysis: retry prompt', () => {
  it('shows retry prompt on retryable error', async () => {
    // Server error (5xx status in response body) is retryable
    mockFetch.mockResolvedValue(makeErrorResponse('Server overloaded', 500));

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    // Start analyze without awaiting — it will pause at retry prompt
    act(() => {
      result.current.analyze();
    });

    // Flush microtasks for buildPayload + runAttempt
    await act(async () => {});

    expect(result.current.retryPrompt).toEqual({
      attempt: 1,
      maxAttempts: 3,
      error: 'Server overloaded',
    });
    expect(result.current.loading).toBe(false);

    // Clean up — cancel the pending retry to release the promise
    act(() => {
      result.current.cancelRetry();
    });
    await act(async () => {});
  });

  it('confirmRetry resumes with the next attempt', async () => {
    // First call: server error. Second call: success.
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse('Server timeout', 500))
      .mockResolvedValueOnce(makeSuccessResponse());

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});

    // Retry prompt should be showing
    expect(result.current.retryPrompt?.attempt).toBe(1);

    // User clicks "Retry Now"
    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    // Second attempt succeeds
    expect(result.current.analysis).toEqual(sampleAnalysis);
    expect(result.current.retryPrompt).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('cancelRetry stops the loop and sets error', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Server error', 500));

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});

    expect(result.current.retryPrompt).not.toBeNull();

    act(() => {
      result.current.cancelRetry();
    });
    await act(async () => {});

    expect(result.current.error).toBe('Retry cancelled.');
    expect(result.current.retryPrompt).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('shows final error after all attempts exhausted', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Server down', 500));

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});

    // Attempt 1 failed → retry prompt
    expect(result.current.retryPrompt?.attempt).toBe(1);

    // Confirm retry → attempt 2
    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    // Attempt 2 failed → retry prompt
    expect(result.current.retryPrompt?.attempt).toBe(2);

    // Confirm retry → attempt 3 (final)
    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    // All attempts exhausted — error shown, no prompt
    expect(result.current.retryPrompt).toBeNull();
    expect(result.current.error).toMatch(/failed after 3 attempts/i);
    expect(result.current.loading).toBe(false);
  });

  it('rebuilds payload on retry (fresh data)', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse('Timeout', 500))
      .mockResolvedValueOnce(makeSuccessResponse());

    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});

    // Confirm retry
    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    // Two /api/analyze calls — each with a freshly built payload
    const analyzeCalls = mockFetch.mock.calls.filter(
      (call) => call[0] === '/api/analyze',
    );
    expect(analyzeCalls.length).toBe(2);

    // Both payloads should be complete JSON
    const body1 = JSON.parse(analyzeCalls[0]![1].body);
    const body2 = JSON.parse(analyzeCalls[1]![1].body);
    expect(body1.images).toHaveLength(1);
    expect(body2.images).toHaveLength(1);
  });
});
