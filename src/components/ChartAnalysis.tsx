/**
 * ChartAnalysis — Upload Market Tide, Net Flow, and/or Periscope screenshots.
 * Sends images + current calculator context to Claude Opus 4.6 with extended thinking.
 * Returns a comprehensive trading plan: structure, strikes, management, entries, hedges.
 *
 * Supports three modes:
 *   - entry:   Pre-trade analysis (default)
 *   - midday:  Mid-day re-analysis
 *   - review:  End-of-day review
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Theme } from '../themes';
import type { CalculationResults } from '../types';
import { SectionBox } from './ui';

// ============================================================
// SUB-COMPONENTS
// ============================================================

const InfoCard = ({
  title,
  color,
  textMuted,
  children,
}: {
  title: string;
  color?: string;
  textMuted: string;
  children: React.ReactNode;
}) => (
  <div className="bg-surface border-edge rounded-lg border p-3">
    <div
      className="mb-1.5 font-sans text-[9px] font-bold tracking-wider uppercase"
      style={{ color: color ?? textMuted }}
    >
      {title}
    </div>
    {children}
  </div>
);

const BulletList = ({
  items,
  icon,
  color,
  textMuted,
}: {
  items: string[];
  icon?: string;
  color?: string;
  textMuted: string;
}) => (
  <div className="grid gap-1">
    {items.map((item, i) => (
      <div
        key={i}
        className="text-secondary flex gap-1.5 text-[11px] leading-relaxed"
      >
        <span className="shrink-0" style={{ color: color ?? textMuted }}>
          {icon ?? '\u2022'}
        </span>
        <span>{item}</span>
      </div>
    ))}
  </div>
);

// ============================================================
// TYPES
// ============================================================

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

type AnalysisMode = 'entry' | 'midday' | 'review';

interface ChartSignal {
  signal: string;
  confidence: string;
  note: string;
}

interface EntryStep {
  timing?: string;
  condition?: string;
  sizePercent: number;
  delta: number;
  structure: string;
  note: string;
}

interface AnalysisResult {
  mode: AnalysisMode;
  structure: string;
  confidence: string;
  suggestedDelta: number;
  reasoning: string;
  chartConfidence?: {
    marketTide?: ChartSignal;
    spyNetFlow?: ChartSignal;
    qqqNetFlow?: ChartSignal;
    periscope?: ChartSignal;
  };
  observations: string[];
  strikeGuidance?: {
    putStrikeNote?: string;
    callStrikeNote?: string;
    straddleCone?: { upper: number; lower: number; priceRelation: string };
    adjustments?: string[];
  } | null;
  managementRules?: {
    profitTarget?: string;
    stopConditions?: string[];
    timeRules?: string;
    flowReversalSignal?: string;
  } | null;
  entryPlan?: {
    entry1?: EntryStep;
    entry2?: EntryStep;
    entry3?: EntryStep;
    maxTotalSize?: string;
    noEntryConditions?: string[];
  } | null;
  risks: string[];
  hedge?: {
    recommendation: string;
    description: string;
    rationale: string;
    estimatedCost: string;
  } | null;
  periscopeNotes?: string | null;
  structureRationale: string;
  review?: {
    wasCorrect: boolean;
    whatWorked: string;
    whatMissed: string;
    optimalTrade: string;
    lessonsLearned: string[];
  } | null;
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

const MODE_LABELS: Record<AnalysisMode, { label: string; desc: string }> = {
  entry: {
    label: 'Pre-Trade',
    desc: 'Full analysis before opening a position',
  },
  midday: { label: 'Mid-Day', desc: 'Check if conditions changed since entry' },
  review: { label: 'Review', desc: 'End-of-day retrospective' },
};

// ============================================================
// COMPONENT
// ============================================================

export default function ChartAnalysis({ th, results, context }: Props) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [mode, setMode] = useState<AnalysisMode>('entry');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [rawResponse, setRawResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [replaceTargetIndex, setReplaceTargetIndex] = useState<number | null>(
    null,
  );
  const replaceInputRef = useRef<HTMLInputElement>(null);

  // ── Image management ──────────────────────────────────────

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
      for (const f of files.slice(0, 5 - images.length)) addImage(f);
    },
    [addImage, images.length],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      for (const f of files.slice(0, 5 - images.length)) addImage(f);
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

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: imageData,
          context: {
            ...context,
            mode,
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
      if (data.analysis) setAnalysis(data.analysis);
      if (data.raw) setRawResponse(data.raw);
      if (!data.analysis && data.raw)
        setError('Could not parse structured response. See raw output below.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  }, [images, context, results, mode]);

  // ── Color helpers ─────────────────────────────────────────

  const structureColor = (s: string) => {
    if (s === 'IRON CONDOR') return th.accent;
    if (s === 'PUT CREDIT SPREAD') return th.red;
    if (s === 'CALL CREDIT SPREAD') return th.green;
    return '#E8A317';
  };

  const confidenceColor = (c: string) => {
    if (c === 'HIGH') return th.green;
    if (c === 'MODERATE') return '#E8A317';
    return th.red;
  };

  const signalColor = (s: string) => {
    if (s === 'BEARISH' || s === 'CONTRADICTS' || s === 'UNFAVORABLE')
      return th.red;
    if (s === 'BULLISH' || s === 'CONFIRMS' || s === 'FAVORABLE')
      return th.green;
    if (s === 'NEUTRAL' || s === 'NOT PROVIDED') return th.textMuted;
    return '#E8A317';
  };

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

        {/* Analyze button */}
        {images.length > 0 && (
          <button
            type="button"
            onClick={analyze}
            disabled={loading}
            className="mb-3 w-full cursor-pointer rounded-lg px-4 py-2.5 font-sans text-[12px] font-bold tracking-wider uppercase transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: th.accent, color: '#fff' }}
          >
            {loading
              ? 'Analyzing charts with Opus...'
              : `Analyze ${images.length} chart${images.length > 1 ? 's' : ''} \u2014 ${MODE_LABELS[mode].label}`}
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

        {/* ════════════════════ RESULTS ════════════════════ */}
        {analysis && (
          <div className="grid gap-2.5">
            {/* ── 1. Primary Recommendation ── */}
            <div
              className="rounded-[10px] p-3.5"
              style={{
                backgroundColor: structureColor(analysis.structure) + '0C',
                border: `1.5px solid ${structureColor(analysis.structure)}30`,
              }}
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
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
                  className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
                  style={{
                    backgroundColor: th.accent + '18',
                    color: th.accent,
                  }}
                >
                  {analysis.suggestedDelta}
                  {'\u0394'}
                </span>
                <span
                  className="text-muted rounded-full px-2 py-0.5 font-mono text-[9px]"
                  style={{ backgroundColor: th.surfaceAlt }}
                >
                  {MODE_LABELS[analysis.mode ?? mode].label}
                </span>
              </div>
              <div className="text-secondary text-[11px] leading-relaxed">
                {analysis.reasoning}
              </div>
            </div>

            {/* ── 2. Per-Chart Confidence ── */}
            {analysis.chartConfidence && (
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {(
                  [
                    ['marketTide', 'Market Tide'],
                    ['spyNetFlow', 'SPY Flow'],
                    ['qqqNetFlow', 'QQQ Flow'],
                    ['periscope', 'Periscope'],
                  ] as const
                ).map(([key, label]) => {
                  const sig = analysis.chartConfidence?.[key];
                  if (!sig || sig.signal === 'NOT PROVIDED') return null;
                  return (
                    <div
                      key={key}
                      className="bg-surface border-edge rounded-md border p-2"
                    >
                      <div className="text-muted mb-0.5 text-[8px] font-bold tracking-wider uppercase">
                        {label}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-[11px] font-bold"
                          style={{ color: signalColor(sig.signal) }}
                        >
                          {sig.signal}
                        </span>
                        <span
                          className="text-[8px] font-semibold"
                          style={{ color: confidenceColor(sig.confidence) }}
                        >
                          {sig.confidence}
                        </span>
                      </div>
                      <div className="text-muted mt-0.5 text-[9px] leading-tight">
                        {sig.note}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── 3. Key Observations ── */}
            <InfoCard textMuted={th.textMuted} title="Key Observations">
              <BulletList
                textMuted={th.textMuted}
                items={analysis.observations}
              />
            </InfoCard>

            {/* ── 4. Strike Guidance (from Periscope) ── */}
            {analysis.strikeGuidance && (
              <InfoCard
                textMuted={th.textMuted}
                title="Strike Placement Guidance"
                color={th.accent}
              >
                <div className="grid gap-1.5">
                  {analysis.strikeGuidance.putStrikeNote && (
                    <div className="text-[11px] leading-relaxed">
                      <span className="text-danger font-semibold">Put: </span>
                      <span className="text-secondary">
                        {analysis.strikeGuidance.putStrikeNote}
                      </span>
                    </div>
                  )}
                  {analysis.strikeGuidance.callStrikeNote && (
                    <div className="text-[11px] leading-relaxed">
                      <span className="text-success font-semibold">Call: </span>
                      <span className="text-secondary">
                        {analysis.strikeGuidance.callStrikeNote}
                      </span>
                    </div>
                  )}
                  {analysis.strikeGuidance.straddleCone && (
                    <div
                      className="text-muted mt-1 rounded-md px-2 py-1 text-[10px]"
                      style={{ backgroundColor: th.surfaceAlt }}
                    >
                      Straddle cone:{' '}
                      {analysis.strikeGuidance.straddleCone.lower} {'\u2013'}{' '}
                      {analysis.strikeGuidance.straddleCone.upper}
                      {' \u2022 '}
                      {analysis.strikeGuidance.straddleCone.priceRelation}
                    </div>
                  )}
                  {analysis.strikeGuidance.adjustments &&
                    analysis.strikeGuidance.adjustments.length > 0 && (
                      <div className="mt-1">
                        <BulletList
                          textMuted={th.textMuted}
                          items={analysis.strikeGuidance.adjustments}
                          icon={'\u2192'}
                          color={th.accent}
                        />
                      </div>
                    )}
                </div>
              </InfoCard>
            )}

            {/* ── 5. Entry Plan ── */}
            {analysis.entryPlan && (
              <InfoCard
                textMuted={th.textMuted}
                title="Entry Plan"
                color={th.accent}
              >
                <div className="grid gap-2">
                  {[
                    analysis.entryPlan.entry1,
                    analysis.entryPlan.entry2,
                    analysis.entryPlan.entry3,
                  ].map((entry, i) => {
                    if (!entry) return null;
                    return (
                      <div
                        key={i}
                        className="bg-surface-alt flex items-start gap-2.5 rounded-md p-2"
                      >
                        <div
                          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold"
                          style={{
                            backgroundColor: th.accent + '18',
                            color: th.accent,
                          }}
                        >
                          {i + 1}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              className="text-[11px] font-semibold"
                              style={{ color: structureColor(entry.structure) }}
                            >
                              {entry.structure}
                            </span>
                            <span
                              className="font-mono text-[10px] font-bold"
                              style={{ color: th.accent }}
                            >
                              {entry.delta}
                              {'\u0394'}
                            </span>
                            <span className="text-muted text-[9px]">
                              {entry.sizePercent}% size
                            </span>
                          </div>
                          <div className="text-muted text-[10px]">
                            {entry.timing ?? entry.condition}
                          </div>
                          <div className="text-secondary mt-0.5 text-[10px] italic">
                            {entry.note}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {analysis.entryPlan.maxTotalSize && (
                    <div className="text-muted text-[10px]">
                      Max size: {analysis.entryPlan.maxTotalSize}
                    </div>
                  )}
                  {analysis.entryPlan.noEntryConditions &&
                    analysis.entryPlan.noEntryConditions.length > 0 && (
                      <div className="mt-1">
                        <div
                          className="mb-0.5 text-[9px] font-bold uppercase"
                          style={{ color: th.red }}
                        >
                          Do NOT add entries if:
                        </div>
                        <BulletList
                          textMuted={th.textMuted}
                          items={analysis.entryPlan.noEntryConditions}
                          icon={'\u2718'}
                          color={th.red}
                        />
                      </div>
                    )}
                </div>
              </InfoCard>
            )}

            {/* ── 6. Position Management Rules ── */}
            {analysis.managementRules && (
              <InfoCard
                textMuted={th.textMuted}
                title="Position Management Rules"
                color="#E8A317"
              >
                <div className="grid gap-1.5">
                  {analysis.managementRules.profitTarget && (
                    <div className="text-[11px] leading-relaxed">
                      <span
                        className="font-semibold"
                        style={{ color: th.green }}
                      >
                        Profit target:{' '}
                      </span>
                      <span className="text-secondary">
                        {analysis.managementRules.profitTarget}
                      </span>
                    </div>
                  )}
                  {analysis.managementRules.stopConditions &&
                    analysis.managementRules.stopConditions.length > 0 && (
                      <div>
                        <span
                          className="text-[10px] font-semibold"
                          style={{ color: th.red }}
                        >
                          Stop conditions:
                        </span>
                        <BulletList
                          textMuted={th.textMuted}
                          items={analysis.managementRules.stopConditions}
                          icon={'\u26D4'}
                          color={th.red}
                        />
                      </div>
                    )}
                  {analysis.managementRules.timeRules && (
                    <div className="text-[11px] leading-relaxed">
                      <span
                        className="font-semibold"
                        style={{ color: '#E8A317' }}
                      >
                        Time rule:{' '}
                      </span>
                      <span className="text-secondary">
                        {analysis.managementRules.timeRules}
                      </span>
                    </div>
                  )}
                  {analysis.managementRules.flowReversalSignal && (
                    <div className="text-[11px] leading-relaxed">
                      <span
                        className="font-semibold"
                        style={{ color: '#E8A317' }}
                      >
                        Flow reversal:{' '}
                      </span>
                      <span className="text-secondary">
                        {analysis.managementRules.flowReversalSignal}
                      </span>
                    </div>
                  )}
                </div>
              </InfoCard>
            )}

            {/* ── 7. Risk Factors ── */}
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
                <BulletList
                  textMuted={th.textMuted}
                  items={analysis.risks}
                  icon={'\u26A0'}
                  color={th.red}
                />
              </div>
            )}

            {/* ── 8. Hedge ── */}
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

            {/* ── 9. Periscope Analysis ── */}
            {analysis.periscopeNotes && (
              <InfoCard textMuted={th.textMuted} title="Periscope Analysis">
                <div className="text-secondary text-[11px] leading-relaxed">
                  {analysis.periscopeNotes}
                </div>
              </InfoCard>
            )}

            {/* ── 10. End-of-Day Review ── */}
            {analysis.review && (
              <div
                className="rounded-[10px] p-3.5"
                style={{
                  backgroundColor: analysis.review.wasCorrect
                    ? th.green + '08'
                    : th.red + '08',
                  border: `1.5px solid ${analysis.review.wasCorrect ? th.green : th.red}20`,
                }}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="font-sans text-[11px] font-bold"
                    style={{
                      color: analysis.review.wasCorrect ? th.green : th.red,
                    }}
                  >
                    {analysis.review.wasCorrect
                      ? '\u2713 Recommendation was correct'
                      : '\u2717 Recommendation was incorrect'}
                  </span>
                </div>
                <div className="grid gap-2">
                  <div className="text-[11px] leading-relaxed">
                    <span className="font-semibold" style={{ color: th.green }}>
                      What worked:{' '}
                    </span>
                    <span className="text-secondary">
                      {analysis.review.whatWorked}
                    </span>
                  </div>
                  <div className="text-[11px] leading-relaxed">
                    <span
                      className="font-semibold"
                      style={{ color: '#E8A317' }}
                    >
                      What was missed:{' '}
                    </span>
                    <span className="text-secondary">
                      {analysis.review.whatMissed}
                    </span>
                  </div>
                  <div className="text-[11px] leading-relaxed">
                    <span
                      className="font-semibold"
                      style={{ color: th.accent }}
                    >
                      Optimal trade:{' '}
                    </span>
                    <span className="text-secondary">
                      {analysis.review.optimalTrade}
                    </span>
                  </div>
                  {analysis.review.lessonsLearned.length > 0 && (
                    <div>
                      <div
                        className="mb-0.5 text-[9px] font-bold tracking-wider uppercase"
                        style={{ color: th.accent }}
                      >
                        Lessons for next time
                      </div>
                      <BulletList
                        textMuted={th.textMuted}
                        items={analysis.review.lessonsLearned}
                        icon={'\u{1F4A1}'}
                        color={th.accent}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── 11. Structure Rationale ── */}
            <div className="text-muted text-[10px] leading-relaxed italic">
              {analysis.structureRationale}
            </div>

            {/* ── 12. Image Issues ── */}
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
                  <strong>Analyze</strong> again.
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
