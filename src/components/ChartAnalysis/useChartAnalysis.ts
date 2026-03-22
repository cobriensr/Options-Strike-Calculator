import { useState, useCallback, useRef, useEffect } from 'react';
import type { CalculationResults } from '../../types';
import type {
  AnalysisMode,
  AnalysisResult,
  AnalysisContext,
  UploadedImage,
} from './types';

export const THINKING_MESSAGES = [
  'Reading chart data...',
  'Fetching open positions...',
  'Analyzing Market Tide flow...',
  'Checking SPX Net Flow...',
  'Checking Net Flow confirmation...',
  'Evaluating gamma exposure...',
  'Checking charm decay profile...',
  'Reading aggregate GEX regime...',
  'Mapping strikes to gamma zones...',
  'Building entry plan...',
  'Assessing hedge options...',
  'Formulating management rules...',
];

/**
 * Build a concise previous recommendation string from a client-side analysis result.
 * This is a FALLBACK — the backend now auto-fetches from DB via getPreviousRecommendation().
 * This client-side version is used when:
 *   - DB doesn't have the previous analysis yet (first run, no save)
 *   - Backtesting mode where analyses may not be saved
 */
function buildPreviousRecommendation(prev: AnalysisResult): string {
  const parts = [
    `Structure: ${prev.structure}, Delta: ${prev.suggestedDelta}, Confidence: ${prev.confidence}`,
    `Reasoning: ${prev.reasoning}`,
  ];
  const e1 = prev.entryPlan?.entry1;
  if (e1) {
    const timing = e1.timing ?? e1.condition ?? '';
    parts.push(`Entry 1: ${e1.structure} ${String(e1.delta)}Δ at ${timing}`);
  }
  if (prev.hedge) {
    parts.push(
      `Hedge: ${prev.hedge.recommendation} — ${prev.hedge.description}`,
    );
  }
  if (prev.managementRules?.profitTarget) {
    parts.push(`Profit target: ${prev.managementRules.profitTarget}`);
  }
  if (prev.managementRules?.stopConditions) {
    parts.push(
      `Stop conditions: ${prev.managementRules.stopConditions.join('; ')}`,
    );
  }
  return parts.join('. ');
}

export function useChartAnalysis(opts: {
  images: UploadedImage[];
  context: AnalysisContext;
  results: CalculationResults | null;
  mode: AnalysisMode;
  onAnalysisSaved?: () => void;
  onModeCompleted?: (mode: AnalysisMode) => void;
}) {
  const { images, context, results, mode, onAnalysisSaved, onModeCompleted } =
    opts;

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const lastAnalysisRef = useRef<AnalysisResult | null>(null);

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
          const buffer = await img.file.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (const b of bytes) binary += String.fromCodePoint(b);
          return {
            data: btoa(binary),
            mediaType: img.file.type,
            label: img.label,
          };
        }),
      );

      // Fetch live positions from Schwab before analysis (fire-and-forget save to DB)
      // The /api/analyze endpoint auto-reads positions from DB, so this just ensures they're fresh
      if (!context.isBacktest && results?.spot) {
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
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Fresh controller per attempt so a timeout on attempt N
        // doesn't poison attempt N+1
        const controller = new AbortController();
        abortRef.current = controller;
        const timeout = setTimeout(() => controller.abort(), 750_000); // 12 min 30s

        try {
          const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: payload,
          });

          clearTimeout(timeout);

          if (!res.ok) {
            const body = await res
              .json()
              .catch(() => ({ error: 'Request failed' }));
            const httpErr = new Error(body.error || `HTTP ${res.status}`);
            (httpErr as Error & { status: number }).status = res.status;
            throw httpErr;
          }

          const data = await res.json();

          // Clear any interim retry message now that we have a response
          lastError = null;
          setError(null);

          if (data.analysis) {
            setAnalysis(data.analysis);
            lastAnalysisRef.current = data.analysis;
            onAnalysisSaved?.();
            // Notify parent so it can lock completed modes
            onModeCompleted?.(mode);
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
  }, [images, context, results, mode, onAnalysisSaved, onModeCompleted]);

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
