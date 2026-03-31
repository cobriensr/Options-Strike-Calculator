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
}) {
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
  const abortRef = useRef<AbortController | null>(null);
  const lastAnalysisRef = useRef<AnalysisResult | null>(null);
  const onAnalysisSavedRef = useRef(onAnalysisSaved);
  const onModeCompletedRef = useRef(onModeCompleted);
  onAnalysisSavedRef.current = onAnalysisSaved;
  onModeCompletedRef.current = onModeCompleted;

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError('Analysis cancelled.');
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

  const analyze = useCallback(async () => {
    if (images.length === 0) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setRawResponse(null);

    try {
      const imageData = await Promise.all(
        images.map(async (img) => {
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

      // Fetch live positions from Schwab before analysis (fire-and-forget save to DB)
      // The /api/analyze endpoint auto-reads positions from DB, so this just ensures they're fresh
      if (!context.isBacktest && results?.spot && !hasCSVPositions) {
        try {
          await fetch(`/api/positions?spx=${results.spot}`, {
            credentials: 'include',
          });
        } catch {
          // Positions are optional — analysis still works without them
          console.warn(
            'Failed to fetch positions — analysis will proceed without them',
          );
        }
      }

      const payload = JSON.stringify({
        images: imageData,
        context: {
          ...context,
          mode,
          sigma: results?.sigma,
          T: results?.T,
          hoursRemaining: results?.hoursRemaining,
          spx: results?.spot,
          // Previous recommendation is now auto-fetched from DB by the backend.
          // Keep the client-side fallback for cases where DB hasn't been populated yet
          // (e.g., first analysis of the day, or backtesting without saved analyses).
          previousRecommendation:
            lastAnalysisRef.current && (mode === 'midday' || mode === 'review')
              ? buildPreviousRecommendation(lastAnalysisRef.current)
              : undefined,
        },
      });

      const MAX_ATTEMPTS = 3;
      // Each attempt gets a full 800s timeout (exceeds backend maxDuration
      // of 780s so the server-side limit is the binding constraint).
      const PER_ATTEMPT_TIMEOUT = 800_000;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Fresh controller per attempt so a timeout on attempt N
        // doesn't poison attempt N+1
        const controller = new AbortController();
        abortRef.current = controller;
        const timeout = setTimeout(
          () => controller.abort(),
          PER_ATTEMPT_TIMEOUT,
        );

        try {
          const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: payload,
          });

          clearTimeout(timeout);

          // Response is NDJSON: keepalive pings followed by the
          // final line with the real payload. Parse the last
          // non-empty line as the response.
          const ndjson = await res.text();
          const lines = ndjson
            .split('\n')
            .filter((l) => l.trim().length > 0);
          const lastLine = lines.at(-1) ?? '{}';
          const data = JSON.parse(lastLine);

          if (data.error) {
            const httpErr = new Error(data.error);
            (httpErr as Error & { status: number }).status = res.status;
            throw httpErr;
          }

          // Clear any interim retry message now that we have a response
          lastError = null;
          setError(null);

          if (data.analysis) {
            setAnalysis(data.analysis);
            lastAnalysisRef.current = data.analysis;
            onAnalysisSavedRef.current?.();
            // Notify parent so it can lock completed modes
            onModeCompletedRef.current?.(mode);

            // Play a notification chime so the user knows analysis is ready
            try {
              const ctx = new AudioContext();
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.type = 'sine';
              // Two-tone chime: E5 → G5
              osc.frequency.setValueAtTime(659.25, ctx.currentTime);
              osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.15);
              gain.gain.setValueAtTime(0.3, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(
                0.01,
                ctx.currentTime + 0.4,
              );
              osc.start(ctx.currentTime);
              osc.stop(ctx.currentTime + 0.4);
            } catch {
              // Audio not available — silent fallback
            }
          }
          if (data.raw) setRawResponse(data.raw);
          if (!data.analysis && data.raw)
            setError(
              'Could not parse structured response. See raw output below.',
            );

          break;
        } catch (err) {
          clearTimeout(timeout);
          lastError = err;

          // User manually cancelled — don't retry
          if (err instanceof DOMException && err.name === 'AbortError') {
            if (!abortRef.current) break; // manual cancel (abortRef cleared)
            // Timeout-triggered abort — retry if attempts remain
            if (attempt === MAX_ATTEMPTS) break;
            setError(
              `Attempt ${attempt}/${MAX_ATTEMPTS} timed out — retrying...`,
            );
            continue;
          }

          // Non-retryable client errors (auth, validation, bad request)
          const status = (err as Error & { status?: number }).status;
          if (status && status >= 400 && status < 500) {
            break;
          }

          // Retryable failure — back off then retry
          if (attempt < MAX_ATTEMPTS) {
            const delaySec = 2 ** (attempt - 1); // 1s, 2s
            setError(
              `Attempt ${attempt}/${MAX_ATTEMPTS} failed — retrying in ${delaySec}s...`,
            );
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          }
        }
      }

      if (lastError) {
        if (
          lastError instanceof DOMException &&
          lastError.name === 'AbortError'
        ) {
          if (abortRef.current)
            setError(
              `Analysis timed out after ${MAX_ATTEMPTS} attempts. Try fewer images or simpler charts.`,
            );
        } else {
          setError(
            lastError instanceof Error ? lastError.message : 'Analysis failed',
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [images, context, results, mode, hasCSVPositions]);

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
  };
}
