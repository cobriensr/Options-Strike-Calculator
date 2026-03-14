/**
 * ChartAnalysis — Upload Market Tide, Net Flow, and/or Periscope screenshots.
 * Sends images + current calculator context to the Anthropic API for analysis.
 * Returns a structured recommendation: IC / Put Spread / Call Spread / Sit Out.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Theme } from '../themes';
import type { CalculationResults } from '../types';
import { SectionBox } from './ui';

interface Props {
  readonly th: Theme;
  readonly results: CalculationResults | null;
  readonly context: AnalysisContext;
}

export interface AnalysisContext {
  selectedDate?: string;
  entryTime?: string;
  spx?: number;
  spy?: number;
  vix?: number;
  vix1d?: number;
  vix9d?: number;
  vvix?: number;
  sigma?: number;
  T?: number;
  hoursRemaining?: number;
  deltaCeiling?: number;
  putSpreadCeiling?: number;
  callSpreadCeiling?: number;
  regimeZone?: string;
  clusterMult?: number;
  dowLabel?: string;
  openingRangeSignal?: string;
  vixTermSignal?: string;
  rvIvRatio?: string;
  overnightGap?: string;
}

interface UploadedImage {
  id: string;
  file: File;
  preview: string;
  label: string;
}

interface AnalysisResult {
  structure:
    | 'IRON CONDOR'
    | 'PUT CREDIT SPREAD'
    | 'CALL CREDIT SPREAD'
    | 'SIT OUT';
  confidence: 'HIGH' | 'MODERATE' | 'LOW';
  suggestedDelta: number;
  reasoning: string;
  observations: string[];
  risks: string[];
  periscopeNotes?: string;
  structureRationale: string;
  hedge?: {
    recommendation:
      | 'NO HEDGE'
      | 'PROTECTIVE LONG'
      | 'DEBIT SPREAD HEDGE'
      | 'REDUCED SIZE'
      | 'SKIP';
    description: string;
    rationale: string;
    estimatedCost: string;
  };
  imageIssues?: Array<{
    imageIndex: number;
    label: string;
    issue: string;
    suggestion: string;
  }>;
}

const CHART_LABELS = [
  'Market Tide (SPX)',
  'Net Flow (SPY)',
  'Net Flow (QQQ)',
  'Periscope (Gamma)',
  'Periscope (Delta Flow)',
  'Other',
] as const;

export default function ChartAnalysis({ th, results, context }: Props) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addImage = useCallback(
    (file: File) => {
      if (images.length >= 5) return;
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = URL.createObjectURL(file);
      setImages((prev) => [
        ...prev,
        { id, file, preview, label: CHART_LABELS[0] },
      ]);
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

  const [replaceTargetIndex, setReplaceTargetIndex] = useState<number | null>(
    null,
  );
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const replaceImage = useCallback((index: number) => {
    setReplaceTargetIndex(index);
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || replaceTargetIndex == null) return;

      setImages((prev) => {
        // Find the image at the target index (1-based from the analysis)
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
      for (const f of files.slice(0, 5 - images.length)) {
        addImage(f);
      }
    },
    [addImage, images.length],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      for (const f of files.slice(0, 5 - images.length)) {
        addImage(f);
      }
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

  // Listen for paste on the entire document so Ctrl+V works anywhere
  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  const analyze = useCallback(async () => {
    if (images.length === 0) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setRawResponse(null);

    try {
      // Convert images to base64
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

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: imageData,
          context: {
            ...context,
            sigma: results?.sigma,
            T: results?.T,
            hoursRemaining: results?.hoursRemaining,
            spx: results?.spot,
          },
        }),
      });

      if (!res.ok) {
        const body = await res
          .json()
          .catch(() => ({ error: 'Request failed' }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.analysis) {
        setAnalysis(data.analysis);
      }
      if (data.raw) {
        setRawResponse(data.raw);
      }
      if (!data.analysis && data.raw) {
        setError('Could not parse structured response. See raw output below.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [images, context, results]);

  const structureColor = (s: string) => {
    if (s === 'IRON CONDOR') return th.accent;
    if (s === 'PUT CREDIT SPREAD') return th.red;
    if (s === 'CALL CREDIT SPREAD') return th.green;
    return '#E8A317'; // SIT OUT
  };

  const confidenceColor = (c: string) => {
    if (c === 'HIGH') return th.green;
    if (c === 'MODERATE') return '#E8A317';
    return th.red;
  };

  return (
    <SectionBox th={th} label="Chart Analysis">
      <div className="font-sans text-[11px] leading-relaxed">
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
              : `${images.length}/5 images \u2014 drop, click, or paste more`}
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
                    {CHART_LABELS.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button
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

        {/* Analyze button */}
        {images.length > 0 && (
          <button
            onClick={analyze}
            disabled={loading}
            className="mb-3 w-full cursor-pointer rounded-lg px-4 py-2.5 font-sans text-[12px] font-bold tracking-wider uppercase transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              backgroundColor: th.accent,
              color: '#fff',
            }}
          >
            {loading
              ? 'Analyzing charts...'
              : `Analyze ${images.length} chart${images.length > 1 ? 's' : ''}`}
          </button>
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
          <div className="grid gap-2.5">
            {/* Primary recommendation */}
            <div
              className="rounded-[10px] p-3.5"
              style={{
                backgroundColor: structureColor(analysis.structure) + '0C',
                border: `1.5px solid ${structureColor(analysis.structure)}30`,
              }}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  className="font-sans text-[15px] font-bold"
                  style={{ color: structureColor(analysis.structure) }}
                >
                  {analysis.structure}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
                  style={{
                    backgroundColor:
                      confidenceColor(analysis.confidence) + '18',
                    color: confidenceColor(analysis.confidence),
                  }}
                >
                  {analysis.confidence}
                </span>
                <span
                  className="text-accent rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
                  style={{ backgroundColor: th.accent + '18' }}
                >
                  {analysis.suggestedDelta}
                  {'\u0394'}
                </span>
              </div>
              <div className="text-secondary text-[11px] leading-relaxed">
                {analysis.reasoning}
              </div>
            </div>

            {/* Observations */}
            <div className="bg-surface border-edge rounded-lg border p-3">
              <div className="text-muted mb-1.5 font-sans text-[9px] font-bold tracking-wider uppercase">
                Key Observations
              </div>
              <div className="grid gap-1">
                {analysis.observations.map((obs, i) => (
                  <div
                    key={i}
                    className="text-secondary flex gap-1.5 text-[11px] leading-relaxed"
                  >
                    <span className="text-muted shrink-0">{'\u2022'}</span>
                    <span>{obs}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Risks */}
            {analysis.risks.length > 0 && (
              <div
                className="rounded-lg p-3"
                style={{
                  backgroundColor: th.red + '08',
                  border: `1px solid ${th.red}15`,
                }}
              >
                <div
                  className="mb-1.5 font-sans text-[9px] font-bold tracking-wider uppercase"
                  style={{ color: th.red }}
                >
                  Risk Factors
                </div>
                <div className="grid gap-1">
                  {analysis.risks.map((risk, i) => (
                    <div
                      key={i}
                      className="text-secondary flex gap-1.5 text-[11px] leading-relaxed"
                    >
                      <span style={{ color: th.red }} className="shrink-0">
                        {'\u26A0'}
                      </span>
                      <span>{risk}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Periscope notes */}
            {analysis.periscopeNotes && (
              <div className="bg-surface border-edge rounded-lg border p-3">
                <div className="text-muted mb-1.5 font-sans text-[9px] font-bold tracking-wider uppercase">
                  Periscope Analysis
                </div>
                <div className="text-secondary text-[11px] leading-relaxed">
                  {analysis.periscopeNotes}
                </div>
              </div>
            )}

            {/* Hedge recommendation */}
            {analysis.hedge && (
              <div
                className="rounded-lg p-3"
                style={{
                  backgroundColor:
                    analysis.hedge.recommendation === 'NO HEDGE'
                      ? th.green + '08'
                      : analysis.hedge.recommendation === 'SKIP'
                        ? th.red + '08'
                        : '#E8A31708',
                  border: `1px solid ${
                    analysis.hedge.recommendation === 'NO HEDGE'
                      ? th.green + '20'
                      : analysis.hedge.recommendation === 'SKIP'
                        ? th.red + '20'
                        : '#E8A31720'
                  }`,
                }}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <span
                    className="font-sans text-[9px] font-bold tracking-wider uppercase"
                    style={{
                      color:
                        analysis.hedge.recommendation === 'NO HEDGE'
                          ? th.green
                          : analysis.hedge.recommendation === 'SKIP'
                            ? th.red
                            : '#E8A317',
                    }}
                  >
                    Hedge: {analysis.hedge.recommendation}
                  </span>
                  {analysis.hedge.estimatedCost &&
                    analysis.hedge.recommendation !== 'NO HEDGE' &&
                    analysis.hedge.recommendation !== 'SKIP' && (
                      <span
                        className="text-muted rounded-full px-1.5 py-0.5 font-mono text-[8px]"
                        style={{ backgroundColor: th.surfaceAlt }}
                      >
                        {analysis.hedge.estimatedCost}
                      </span>
                    )}
                </div>
                <div className="text-secondary text-[11px] leading-relaxed">
                  {analysis.hedge.description}
                </div>
                {analysis.hedge.rationale && (
                  <div className="text-muted mt-1 text-[10px] leading-relaxed italic">
                    {analysis.hedge.rationale}
                  </div>
                )}
              </div>
            )}

            {/* Structure rationale */}
            <div className="text-muted text-[10px] leading-relaxed italic">
              {analysis.structureRationale}
            </div>

            {/* Image issues — prompt to replace unreadable images */}
            {analysis.imageIssues && analysis.imageIssues.length > 0 && (
              <div
                className="rounded-lg p-3"
                style={{
                  backgroundColor: '#E8A31708',
                  border: '1px solid #E8A31720',
                }}
              >
                <div
                  className="mb-2 font-sans text-[9px] font-bold tracking-wider uppercase"
                  style={{ color: '#E8A317' }}
                >
                  Image Issues {'\u2014'} {analysis.imageIssues.length} image
                  {analysis.imageIssues.length > 1 ? 's' : ''} need
                  {analysis.imageIssues.length === 1 ? 's' : ''} improvement
                </div>
                <div className="grid gap-2">
                  {analysis.imageIssues.map((issue, i) => (
                    <div
                      key={i}
                      className="bg-surface border-edge flex items-start gap-2.5 rounded-md border p-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div
                          className="mb-0.5 font-sans text-[11px] font-semibold"
                          style={{ color: '#E8A317' }}
                        >
                          Image {issue.imageIndex}: {issue.label}
                        </div>
                        <div className="text-secondary text-[10px] leading-relaxed">
                          {issue.issue}
                        </div>
                        <div className="text-muted mt-0.5 text-[10px] italic">
                          {'\u2192'} {issue.suggestion}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => replaceImage(issue.imageIndex)}
                        className="shrink-0 cursor-pointer rounded-md px-2.5 py-1.5 font-sans text-[10px] font-semibold transition-opacity hover:opacity-80"
                        style={{
                          backgroundColor: '#E8A31718',
                          color: '#E8A317',
                          border: '1px solid #E8A31730',
                        }}
                      >
                        Replace
                      </button>
                    </div>
                  ))}
                </div>
                <div className="text-muted mt-2 text-[10px]">
                  Replace the flagged image
                  {analysis.imageIssues.length > 1 ? 's' : ''}, then click{' '}
                  <strong>Analyze</strong> again for an updated recommendation.
                </div>
              </div>
            )}
          </div>
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
