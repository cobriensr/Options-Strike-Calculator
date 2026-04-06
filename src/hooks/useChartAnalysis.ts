import { useState, useCallback, useRef, useEffect } from 'react';
import type { CalculationResults } from '../types';
import type {
  AnalysisMode,
  AnalysisResult,
  AnalysisContext,
  UploadedImage,
} from '../components/ChartAnalysis/types';
import { THINKING_MESSAGES } from '../constants';
import { buildPreviousRecommendation } from '../utils/analysis';
import { getErrorMessage } from '../utils/error';

export interface RetryPrompt {
  attempt: number;
  maxAttempts: number;
  error: string;
}

export interface UseChartAnalysisReturn {
  analysis: AnalysisResult | null;
  rawResponse: string | null;
  loading: boolean;
  error: string | null;
  elapsed: number;
  analyze: () => Promise<void>;
  cancelAnalysis: () => void;
  lastAnalysis: AnalysisResult | null;
  THINKING_MESSAGES: typeof THINKING_MESSAGES;
  retryPrompt: RetryPrompt | null;
  confirmRetry: () => void;
  cancelRetry: () => void;
}

const MAX_ATTEMPTS = 3;
// Each attempt gets a full 800s timeout (exceeds backend maxDuration
// of 780s so the server-side limit is the binding constraint).
const PER_ATTEMPT_TIMEOUT = 800_000;

async function compressImage(
  file: File,
  maxWidth = 1600,
  quality = 0.75,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.convertToBlob({ type: 'image/jpeg', quality });
}

export function useChartAnalysis(opts: {
  images: UploadedImage[];
  context: AnalysisContext;
  results: CalculationResults | null;
  mode: AnalysisMode;
  hasCSVPositions?: boolean;
  onAnalysisSaved?: () => void;
  onModeCompleted?: (mode: AnalysisMode) => void;
}): UseChartAnalysisReturn {
  const {
    images,
    context,
    results,
    mode,
    onAnalysisSaved,
    onModeCompleted,
    hasCSVPositions,
  } = opts;

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [retryPrompt, setRetryPrompt] = useState<RetryPrompt | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastAnalysisRef = useRef<AnalysisResult | null>(null);
  const onAnalysisSavedRef = useRef(onAnalysisSaved);
  const onModeCompletedRef = useRef(onModeCompleted);
  onAnalysisSavedRef.current = onAnalysisSaved;
  onModeCompletedRef.current = onModeCompleted;

  // Refs for values that must be fresh on retry — the user may update
  // screenshots or market conditions may change during the 10+ minute wait.
  const imagesRef = useRef(images);
  const contextRef = useRef(context);
  const resultsRef = useRef(results);
  const modeRef = useRef(mode);
  const hasCSVPositionsRef = useRef(hasCSVPositions);
  imagesRef.current = images;
  contextRef.current = context;
  resultsRef.current = results;
  modeRef.current = mode;
  hasCSVPositionsRef.current = hasCSVPositions;

  // Promise resolver for the pausable retry loop — resolves when the
  // user clicks "Retry" or "Cancel" in the retry prompt dialog.
  const retryResolverRef = useRef<
    ((action: 'retry' | 'cancel') => void) | null
  >(null);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    retryResolverRef.current?.('cancel');
    retryResolverRef.current = null;
    setRetryPrompt(null);
    setLoading(false);
    setError('Analysis cancelled.');
  }, []);

  const confirmRetry = useCallback(() => {
    retryResolverRef.current?.('retry');
    retryResolverRef.current = null;
  }, []);

  const cancelRetry = useCallback(() => {
    retryResolverRef.current?.('cancel');
    retryResolverRef.current = null;
    setRetryPrompt(null);
    setLoading(false);
    setError('Retry cancelled.');
  }, []);

  // Elapsed timer while loading
  useEffect(() => {
    if (!loading) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [loading]);

  // Build a fresh payload from current ref values so retries
  // always send up-to-date market data and potentially new images.
  const buildPayload = useCallback(async () => {
    const currentImages = imagesRef.current;
    const currentContext = contextRef.current;
    const currentResults = resultsRef.current;
    const currentMode = modeRef.current;

    const imageData = await Promise.all(
      currentImages.map(async (img) => {
        const compressed = await compressImage(img.file);
        const buffer = await compressed.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (const b of bytes) binary += String.fromCodePoint(b);
        return {
          data: btoa(binary),
          mediaType: 'image/jpeg',
          label: img.label,
        };
      }),
    );

    // Fetch live positions from Schwab (fire-and-forget save to DB)
    if (
      !currentContext.isBacktest &&
      currentResults?.spot &&
      !hasCSVPositionsRef.current
    ) {
      try {
        await fetch(`/api/positions?spx=${currentResults.spot}`, {
          credentials: 'include',
        });
      } catch {
        console.warn(
          'Failed to fetch positions — analysis will proceed without them',
        );
      }
    }

    return JSON.stringify({
      images: imageData,
      context: {
        ...currentContext,
        mode: currentMode,
        sigma: currentResults?.sigma,
        T: currentResults?.T,
        hoursRemaining: currentResults?.hoursRemaining,
        spx: currentResults?.spot,
        previousRecommendation:
          lastAnalysisRef.current &&
          (currentMode === 'midday' || currentMode === 'review')
            ? buildPreviousRecommendation(lastAnalysisRef.current)
            : undefined,
      },
    });
  }, []);

  /** Play a two-tone chime when analysis completes. */
  const playChime = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, ctx.currentTime);
      osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch {
      // Audio not available — silent fallback
    }
  }, []);

  /**
   * Run a single analysis attempt. Returns a discriminated result so
   * the caller can decide whether to prompt for retry.
   */
  const runAttempt = useCallback(
    async (
      payload: string,
    ): Promise<
      | { outcome: 'success' }
      | { outcome: 'partial' }
      | { outcome: 'retryable'; error: string }
      | { outcome: 'fatal'; error: string }
    > => {
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT);

      try {
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: payload,
        });

        clearTimeout(timeout);

        const ndjson = await res.text();
        const lines = ndjson.split('\n').filter((l) => l.trim().length > 0);
        const lastLine = lines.at(-1) ?? '{}';
        const data = JSON.parse(lastLine);

        if (data.error) {
          const status = res.status;
          if (status >= 400 && status < 500) {
            return { outcome: 'fatal', error: data.error };
          }
          return { outcome: 'retryable', error: data.error };
        }

        // Server timed out mid-stream — last NDJSON line is a keepalive
        if (!data.analysis && !data.raw && !data.error) {
          return {
            outcome: 'retryable',
            error:
              'Server connection dropped \u2014 the analysis may have timed out.',
          };
        }

        if (data.analysis) {
          setAnalysis(data.analysis);
          lastAnalysisRef.current = data.analysis;
          onAnalysisSavedRef.current?.();
          onModeCompletedRef.current?.(modeRef.current);
          playChime();
        }
        if (data.raw) setRawResponse(data.raw);

        // Raw text present but no structured analysis — partial success
        if (!data.analysis && data.raw) {
          return { outcome: 'partial' };
        }

        return { outcome: 'success' };
      } catch (err) {
        clearTimeout(timeout);

        // User manually cancelled
        if (err instanceof DOMException && err.name === 'AbortError') {
          if (!abortRef.current) {
            return { outcome: 'fatal', error: 'Analysis cancelled.' };
          }
          // Timeout-triggered abort
          return {
            outcome: 'retryable',
            error: 'Request timed out.',
          };
        }

        // Non-retryable client errors
        const status = (err as Error & { status?: number }).status;
        if (status && status >= 400 && status < 500) {
          return { outcome: 'fatal', error: getErrorMessage(err) };
        }

        return { outcome: 'retryable', error: getErrorMessage(err) };
      }
    },
    [playChime],
  );

  const analyze = useCallback(async () => {
    if (imagesRef.current.length === 0) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setRawResponse(null);
    setRetryPrompt(null);

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Build a fresh payload each attempt so market data and
        // potentially updated screenshots are current.
        if (attempt > 1) {
          setError(`Starting attempt ${attempt}/${MAX_ATTEMPTS}...`);
        }

        const payload = await buildPayload();
        const result = await runAttempt(payload);

        if (result.outcome === 'success') {
          setError(null);
          break;
        }

        if (result.outcome === 'partial') {
          setError(
            'Could not parse structured response. See raw output below.',
          );
          break;
        }

        if (result.outcome === 'fatal') {
          setError(result.error);
          break;
        }

        // Retryable failure — prompt the user before continuing
        if (attempt < MAX_ATTEMPTS) {
          setLoading(false);
          setRetryPrompt({
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            error: result.error,
          });

          // Pause the loop until the user decides
          const action = await new Promise<'retry' | 'cancel'>((resolve) => {
            retryResolverRef.current = resolve;
          });

          if (action === 'cancel') {
            setRetryPrompt(null);
            setError('Retry cancelled.');
            break;
          }

          // User chose to retry — resume with fresh data
          setRetryPrompt(null);
          setLoading(true);
        } else {
          // Final attempt exhausted
          setError(
            `Analysis failed after ${MAX_ATTEMPTS} attempts: ${result.error}`,
          );
        }
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      abortRef.current = null;
      setRetryPrompt(null);
      setLoading(false);
    }
  }, [buildPayload, runAttempt]);

  return {
    analysis,
    rawResponse,
    loading,
    error,
    elapsed,
    analyze,
    cancelAnalysis,
    lastAnalysis: lastAnalysisRef.current,
    THINKING_MESSAGES,
    retryPrompt,
    confirmRetry,
    cancelRetry,
  };
}
