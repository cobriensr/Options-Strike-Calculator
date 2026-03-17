/**
 * ChartAnalysis — Upload Market Tide, Net Flow, and/or Periscope screenshots.
 * Sends images + current calculator context to Claude Opus 4.6 with adaptive thinking.
 * Returns a comprehensive trading plan: structure, strikes, management, entries, hedges.
 *
 * Supports three modes:
 *   - entry:   Pre-trade analysis (default)
 *   - midday:  Mid-day re-analysis
 *   - review:  End-of-day review
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Theme } from '../../themes';
import type { CalculationResults } from '../../types';
import { SectionBox } from '../ui';
import type { AnalysisMode, AnalysisResult, UploadedImage } from './types';
import { CHART_LABELS, MODE_LABELS } from './types';
import AnalysisResultsView from './AnalysisResults';
import { fetchWithRetry } from '../../utils/fetchWithRetry';

export type { AnalysisContext } from './types';

interface Props {
  readonly th: Theme;
  readonly results: CalculationResults | null;
  readonly context: import('./types').AnalysisContext;
}

export default function ChartAnalysis({ th, results, context }: Props) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [mode, setMode] = useState<AnalysisMode>('entry');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [replaceTargetIndex, setReplaceTargetIndex] = useState<number | null>(
    null,
  );
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastAnalysisRef = useRef<AnalysisResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError('Analysis cancelled.');
  }, []);

  // ── Image management ──────────────────────────────────────

  const addImage = useCallback(
    (file: File) => {
      if (images.length >= 6) return;
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = URL.createObjectURL(file);
      setImages((prev) => {
        const usedLabels = new Set(prev.map((i) => i.label));
        const nextLabel =
          CHART_LABELS.find((l) => !usedLabels.has(l)) ?? CHART_LABELS[0];
        return [...prev, { id, file, preview, label: nextLabel }];
      });
    },
    [images.length],
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const updateLabel = useCallback((id: string, label: string) => {
    setImages((prev) => prev.map((i) => (i.id === id ? { ...i, label } : i)));
  }, []);

  const replaceImage = useCallback((index: number) => {
    setReplaceTargetIndex(index);
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || replaceTargetIndex == null) return;
      setImages((prev) => {
        const targetIdx = replaceTargetIndex - 1;
        if (targetIdx < 0 || targetIdx >= prev.length) return prev;
        const old = prev[targetIdx]!;
        URL.revokeObjectURL(old.preview);
        const newImg: UploadedImage = {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          file,
          preview: URL.createObjectURL(file),
          label: old.label,
        };
        return [
          ...prev.slice(0, targetIdx),
          newImg,
          ...prev.slice(targetIdx + 1),
        ];
      });
      setReplaceTargetIndex(null);
      if (replaceInputRef.current) replaceInputRef.current.value = '';
    },
    [replaceTargetIndex],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith('image/'),
      );
      for (const f of files.slice(0, 6 - images.length)) addImage(f);
    },
    [addImage, images.length],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      for (const f of files.slice(0, 6 - images.length)) addImage(f);
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [addImage, images.length],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) addImage(file);
        }
      }
    },
    [addImage],
  );

  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

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

  const THINKING_MESSAGES = [
    'Reading chart data...',
    'Fetching open positions...',
    'Analyzing Market Tide flow...',
    'Checking SPX Net Flow...',
    'Checking Net Flow confirmation...',
    'Evaluating gamma exposure...',
    'Mapping strikes to gamma zones...',
    'Building entry plan...',
    'Assessing hedge options...',
    'Formulating management rules...',
  ];

  // ── Analysis ──────────────────────────────────────────────

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

      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), 240_000); // 4 min

      const res = await fetchWithRetry('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        maxRetries: 2,
        body: JSON.stringify({
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
              lastAnalysisRef.current &&
              (mode === 'midday' || mode === 'review')
                ? buildPreviousRecommendation(lastAnalysisRef.current)
                : undefined,
          },
        }),
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ error: 'Request failed' }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.analysis) {
        setAnalysis(data.analysis);
        lastAnalysisRef.current = data.analysis;
      }
      if (data.raw) setRawResponse(data.raw);
      if (!data.analysis && data.raw)
        setError('Could not parse structured response. See raw output below.');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // abortRef is null if cancelAnalysis was called (it clears it); non-null means timeout
        if (abortRef.current)
          setError(
            'Analysis timed out (>4 min). Try fewer images or simpler charts.',
          );
      } else {
        setError(err instanceof Error ? err.message : 'Analysis failed');
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [images, context, results, mode]);

  // ── Render ────────────────────────────────────────────────

  return (
    <SectionBox th={th} label="Chart Analysis">
      <div className="font-sans text-[11px] leading-relaxed">
        {/* Mode selector */}
        <div className="mb-3 flex gap-1.5">
          {(Object.keys(MODE_LABELS) as AnalysisMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className="cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-all"
              style={{
                backgroundColor: mode === m ? th.accent + '18' : th.surfaceAlt,
                color: mode === m ? th.accent : th.textMuted,
                border: `1px solid ${mode === m ? th.accent + '40' : 'transparent'}`,
              }}
            >
              {MODE_LABELS[m].label}
            </button>
          ))}
          <span className="text-muted ml-2 self-center text-[10px] italic">
            {MODE_LABELS[mode].desc}
          </span>
        </div>

        {/* Drop zone */}
        <button
          type="button"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="border-edge bg-surface-alt mb-3 w-full cursor-pointer rounded-lg border-2 border-dashed p-4 text-center transition-colors hover:border-[var(--th-accent)]"
          onClick={() => fileInputRef.current?.click()}
          aria-label="Upload chart images"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleReplaceFile}
          />
          <div className="text-muted text-[12px]">
            {images.length === 0
              ? 'Drop or click to upload, or paste (Ctrl+V) a screenshot from clipboard'
              : `${images.length}/6 images \u2014 drop, click, or paste more`}
          </div>
        </button>

        {/* Image previews */}
        {images.length > 0 && (
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {images.map((img) => (
              <div
                key={img.id}
                className="bg-surface border-edge relative overflow-hidden rounded-lg border"
              >
                <img
                  src={img.preview}
                  alt={img.label}
                  className="h-24 w-full object-cover object-top"
                />
                <div className="flex items-center gap-1.5 p-1.5">
                  <select
                    value={img.label}
                    onChange={(e) => updateLabel(img.id, e.target.value)}
                    className="bg-surface-alt border-edge flex-1 rounded border px-1 py-0.5 font-sans text-[10px]"
                  >
                    {CHART_LABELS.filter(
                      (l) =>
                        l === img.label ||
                        !images.some((o) => o.id !== img.id && o.label === l),
                    ).map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeImage(img.id);
                    }}
                    className="text-muted hover:text-danger text-[14px] leading-none"
                    aria-label="Remove image"
                  >
                    {'\u00D7'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Analyze button + confirmation step */}
        {images.length > 0 && !loading && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mb-3 w-full cursor-pointer rounded-lg px-4 py-2.5 font-sans text-[12px] font-bold tracking-wider uppercase transition-opacity"
            style={{ backgroundColor: th.accent, color: '#fff' }}
          >
            {`Analyze ${images.length} chart${images.length > 1 ? 's' : ''} \u2014 ${MODE_LABELS[mode].label}`}
          </button>
        )}

        {confirming && !loading && (
          <div
            className="mb-3 flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: '#E8A31710',
              border: '1.5px solid #E8A31730',
            }}
          >
            <div>
              <div
                className="font-sans text-[11px] font-semibold"
                style={{ color: '#E8A317' }}
              >
                Send {images.length} image{images.length > 1 ? 's' : ''} to
                Opus? (~1{'\u20134'} min, billed on send)
              </div>
              <div className="text-muted mt-0.5 font-sans text-[10px]">
                {MODE_LABELS[mode].label} {'\u2022'}{' '}
                {images.map((img) => img.label).join(', ')}
                {!context.isBacktest && (
                  <span style={{ color: th.accent }}>
                    {' \u2022'} Will fetch live positions from Schwab
                  </span>
                )}
                {lastAnalysisRef.current &&
                  (mode === 'midday' || mode === 'review') && (
                    <span style={{ color: th.green }}>
                      {' '}
                      {'\u2022'} Includes previous{' '}
                      {lastAnalysisRef.current.structure} recommendation
                    </span>
                  )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="cursor-pointer rounded-md px-3 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
                style={{ backgroundColor: th.surfaceAlt, color: th.textMuted }}
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  analyze();
                }}
                className="cursor-pointer rounded-md px-4 py-1.5 font-sans text-[10px] font-bold tracking-wider uppercase transition-opacity hover:opacity-90"
                style={{ backgroundColor: th.accent, color: '#fff' }}
              >
                Confirm
              </button>
            </div>
          </div>
        )}

        {loading && (
          <div
            className="border-edge mb-3 overflow-hidden rounded-lg border p-4"
            style={{ backgroundColor: th.surfaceAlt }}
          >
            {/* Pulsing bar */}
            <div
              className="mb-3 h-1 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: th.accent + '20' }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  backgroundColor: th.accent,
                  width: `${Math.min(95, (elapsed / 140) * 100)}%`,
                  transition: 'width 1s linear',
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div
                  className="mb-0.5 font-sans text-[11px] font-semibold"
                  style={{ color: th.accent }}
                >
                  Opus is thinking...
                </div>
                <div className="text-muted font-sans text-[10px]">
                  {
                    THINKING_MESSAGES[
                      Math.min(
                        Math.floor(elapsed / 8),
                        THINKING_MESSAGES.length - 1,
                      )
                    ]
                  }
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div
                  className="font-mono text-[12px] font-bold"
                  style={{ color: th.textMuted }}
                >
                  {elapsed}s
                </div>
                <button
                  type="button"
                  onClick={cancelAnalysis}
                  className="cursor-pointer rounded-md px-3 py-1 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
                  style={{
                    backgroundColor: th.red + '18',
                    color: th.red,
                    border: `1px solid ${th.red}30`,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            className="mb-3 rounded-lg px-3 py-2 text-[11px]"
            style={{ backgroundColor: th.red + '12', color: th.red }}
          >
            {error}
          </div>
        )}

        {/* Results */}
        {analysis && (
          <AnalysisResultsView
            th={th}
            analysis={analysis}
            mode={mode}
            onReplaceImage={replaceImage}
          />
        )}

        {/* Raw response fallback */}
        {!analysis && rawResponse && (
          <div className="bg-surface-alt border-edge rounded-lg border p-3">
            <div className="text-muted mb-1 font-sans text-[9px] font-bold tracking-wider uppercase">
              Raw Analysis
            </div>
            <pre className="text-secondary max-h-48 overflow-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
              {rawResponse}
            </pre>
          </div>
        )}
      </div>
    </SectionBox>
  );
}

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
