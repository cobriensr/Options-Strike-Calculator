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

// The hold a run takes on a waiting service-worker update, and its release.
const { holdAutoUpdate, release } = vi.hoisted(() => {
  const releaseHold = vi.fn();
  return { holdAutoUpdate: vi.fn(() => releaseHold), release: releaseHold };
});
vi.mock('../../lib/sw-update', () => ({ holdAutoUpdate }));

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
  {
    id: '1',
    file: mockFile,
    preview: 'blob:url',
    label: 'UW Periscope (Gamma)',
  },
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
    expect(body.images[0].label).toBe('UW Periscope (Gamma)');
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

// ============================================================
// HOLD ON A WAITING UPDATE
// ============================================================

// A reload drops the request (up to 780 s) and a pending retry decision, so a
// run keeps a waiting service-worker update from applying until it is over.
describe('useChartAnalysis: hold on a waiting update', () => {
  it('takes the hold before building the payload and releases it when the run ends', async () => {
    // With a spot price, building the payload fetches positions first, so the
    // run's first request is made before the analyze request is built.
    const seen: { url: string; holds: number; releases: number }[] = [];
    mockFetch.mockImplementation((url: string) => {
      seen.push({
        url,
        holds: holdAutoUpdate.mock.calls.length,
        releases: release.mock.calls.length,
      });
      return Promise.resolve(makeSuccessResponse());
    });

    const { result } = renderHook(() =>
      useChartAnalysis(defaultOpts({ results: { spot: 5000 } })),
    );
    await act(async () => {
      await result.current.analyze();
    });

    expect(seen).toEqual([
      { url: '/api/positions?spx=5000', holds: 1, releases: 0 },
      { url: '/api/analyze', holds: 1, releases: 0 },
    ]);
    expect(holdAutoUpdate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps the hold while the request is in flight and releases it on cancel', async () => {
    vi.useFakeTimers();
    mockFetch.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    let analyzePromise: Promise<void> | undefined;
    act(() => {
      analyzePromise = result.current.analyze();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.loading).toBe(true);
    expect(holdAutoUpdate).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    act(() => {
      result.current.cancelAnalysis();
    });
    await act(async () => {
      await analyzePromise;
    });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('holds across the retry prompt and every attempt with one hold', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse('Server timeout', 500))
      .mockResolvedValueOnce(makeSuccessResponse());
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});

    // The run is paused on the user's decision, loading is false, and the
    // reload would still lose the retry.
    expect(result.current.retryPrompt).not.toBeNull();
    expect(result.current.loading).toBe(false);
    expect(holdAutoUpdate).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    expect(result.current.analysis).toEqual(sampleAnalysis);
    expect(holdAutoUpdate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the hold when the user cancels the retry', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Server error', 500));
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});
    expect(release).not.toHaveBeenCalled();

    act(() => {
      result.current.cancelRetry();
    });
    await act(async () => {});

    expect(result.current.error).toBe('Retry cancelled.');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the hold once all attempts are exhausted', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Server down', 500));
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});
    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});
    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    expect(result.current.error).toMatch(/failed after 3 attempts/i);
    expect(holdAutoUpdate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the hold on a fatal 4xx response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Bad request', 400));
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()));

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.error).toBe('Bad request');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases the hold when the run throws before the request', async () => {
    // A null context makes buildPayload throw, which the hook's catch turns
    // into an error message.
    const { result } = renderHook(() =>
      useChartAnalysis(defaultOpts({ context: null })),
    );

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.error).toMatch(/null/i);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(holdAutoUpdate).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('takes no hold when there are no images to analyze', async () => {
    const { result } = renderHook(() =>
      useChartAnalysis(defaultOpts({ images: [] })),
    );

    await act(async () => {
      await result.current.analyze();
    });

    expect(holdAutoUpdate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

// The host panel can unmount mid-run (hidden from the prefs modal, or an error
// boundary catch). The request itself is not aborted, since its result still
// saves server-side, so the hold stays until the request ends; but a retry
// prompt nobody can answer must not park the run, or the hold would last until
// the page reloads.
describe('useChartAnalysis: hold when the host unmounts', () => {
  const analyzeCalls = () =>
    mockFetch.mock.calls.filter((call) => call[0] === '/api/analyze');

  it('releases the hold when the host unmounts at the retry prompt', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse('Server overloaded', 500));
    const { result, unmount } = renderHook(() =>
      useChartAnalysis(defaultOpts()),
    );

    let settled = false;
    act(() => {
      result.current.analyze().then(() => {
        settled = true;
      });
    });
    await act(async () => {});
    expect(result.current.retryPrompt).not.toBeNull();
    expect(release).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    unmount();
    await act(async () => {});

    expect(settled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(analyzeCalls()).toHaveLength(1);
  });

  it('keeps the hold through an in-flight request after unmount, then ends the run on its failure', async () => {
    let failRequest: () => void = () => undefined;
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          failRequest = () =>
            resolve(makeErrorResponse('Server overloaded', 500));
        }),
    );
    const { result, unmount } = renderHook(() =>
      useChartAnalysis(defaultOpts()),
    );

    let settled = false;
    act(() => {
      result.current.analyze().then(() => {
        settled = true;
      });
    });
    await act(async () => {});
    expect(analyzeCalls()).toHaveLength(1);

    unmount();
    await act(async () => {});
    expect(release).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    failRequest();
    await act(async () => {});

    expect(settled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(analyzeCalls()).toHaveLength(1);
  });

  it('does not abort the request on unmount and keeps the hold until it ends', async () => {
    let finishRequest: () => void = () => undefined;
    let requestSignal: AbortSignal | undefined;
    mockFetch.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          requestSignal = opts.signal;
          finishRequest = () => resolve(makeSuccessResponse());
        }),
    );
    const { result, unmount } = renderHook(() =>
      useChartAnalysis(defaultOpts()),
    );

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});
    unmount();
    await act(async () => {});
    expect(requestSignal?.aborted).toBe(false);
    expect(release).not.toHaveBeenCalled();

    finishRequest();
    await act(async () => {});

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('still parks at the retry prompt of a mounted host, even under StrictMode remounts', async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse('Server overloaded', 500))
      .mockResolvedValueOnce(makeSuccessResponse());
    const { result } = renderHook(() => useChartAnalysis(defaultOpts()), {
      reactStrictMode: true,
    });

    act(() => {
      result.current.analyze();
    });
    await act(async () => {});

    expect(result.current.retryPrompt?.attempt).toBe(1);
    expect(release).not.toHaveBeenCalled();

    act(() => {
      result.current.confirmRetry();
    });
    await act(async () => {});

    expect(result.current.analysis).toEqual(sampleAnalysis);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
