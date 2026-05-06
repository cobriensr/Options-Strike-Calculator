/**
 * Periscope Chat panel.
 *
 * Manual upload of 1-3 Periscope screenshots → Claude analysis via the
 * `periscope` skill. Mode toggle (Read / Debrief), per-kind drag-drop
 * slots, optional parent_id (debrief mode), submit button, response
 * area showing the structured fields + the prose.
 *
 * State + submission live in `usePeriscopeChat`. This component is
 * presentation only.
 */

import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { SectionBox } from '../ui/SectionBox';
import { usePeriscopeChat } from './usePeriscopeChat.js';
import { ProseView } from './PeriscopeProse.js';
import PlaybookView from './PlaybookView.js';
import type { PeriscopeMode, PeriscopeStructuredFields } from './types.js';
import { PERISCOPE_IMAGE_KINDS } from './types.js';

const MODE_OPTIONS: ReadonlyArray<{ value: PeriscopeMode; label: string }> = [
  { value: 'pre_trade', label: 'Pre-trade' },
  { value: 'intraday', label: 'Intraday' },
  { value: 'debrief', label: 'Debrief' },
];

/** Pre-built HH:MM options at 10-min granularity covering the full day. */
const TIME_OPTIONS: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 10) {
      const hh = h.toString().padStart(2, '0');
      const mm = m.toString().padStart(2, '0');
      out.push(`${hh}:${mm}`);
    }
  }
  return out;
})();

/**
 * Custom event name dispatched by PeriscopeChatHistory when the user
 * clicks "Debrief this" on a past row. The chat panel listens and
 * pre-fills mode + parentId so the user can immediately attach
 * screenshots and submit. Uses a window event (rather than props /
 * context) because the two panels are sibling lazy-loaded sections
 * — lifting state to App.tsx would couple them across the lazy
 * boundary.
 */
export const PERISCOPE_DEBRIEF_EVENT = 'periscope:start-debrief';

interface DebriefEventDetail {
  parentId: number;
}

// ============================================================
// Per-kind drag-drop slot
// ============================================================

interface ImageSlotProps {
  label: string;
  hint: string;
  preview: string | null;
  disabled: boolean;
  onSelect: (file: File | null) => void;
}

function ImageSlot({
  label,
  hint,
  preview,
  disabled,
  onSelect,
}: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) onSelect(file);
    },
    [disabled, onSelect],
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  }, []);

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      onSelect(file);
      // Reset the input so re-uploading the same file fires onChange again.
      if (inputRef.current) inputRef.current.value = '';
    },
    [onSelect],
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    inputRef.current?.click();
  }, [disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-secondary text-xs font-medium">
        {label}
      </label>
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={`Upload ${label}`}
        aria-disabled={disabled}
        className={`border-edge bg-surface/40 relative flex min-h-32 cursor-pointer items-center justify-center rounded-md border border-dashed p-2 text-center transition hover:border-[var(--color-accent)] focus:border-[var(--color-accent)] focus:outline-none ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        {preview ? (
          <>
            <img
              src={preview}
              alt={`${label} preview`}
              className="max-h-40 max-w-full rounded object-contain"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSelect(null);
              }}
              className="absolute top-1 right-1 rounded bg-black/60 px-2 py-0.5 text-xs text-white hover:bg-black/80"
              aria-label={`Remove ${label}`}
            >
              ✕
            </button>
          </>
        ) : (
          <span className="text-muted text-xs">{hint}</span>
        )}
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={handleFileChange}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

// ============================================================
// Structured-fields display
// ============================================================

interface StructuredFieldsViewProps {
  fields: PeriscopeStructuredFields;
}

const fmtNum = (n: number | null) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function StructuredFieldsView({ fields }: StructuredFieldsViewProps) {
  const rows: Array<{ label: string; value: string }> = useMemo(() => {
    return [
      { label: 'Spot', value: fmtNum(fields.spot) },
      {
        label: 'Cone',
        value:
          fields.cone_lower == null && fields.cone_upper == null
            ? '—'
            : `${fmtNum(fields.cone_lower)} – ${fmtNum(fields.cone_upper)}`,
      },
      { label: 'Long trigger', value: fmtNum(fields.long_trigger) },
      { label: 'Short trigger', value: fmtNum(fields.short_trigger) },
      { label: 'Regime', value: fields.regime_tag ?? '—' },
    ];
  }, [fields]);

  return (
    <div className="border-edge bg-surface/60 grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border p-3 text-sm sm:grid-cols-5">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col">
          <span className="text-muted text-[10px] tracking-wide uppercase">
            {row.label}
          </span>
          <span className="text-primary font-mono">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Main panel
// ============================================================

export default function PeriscopeChat() {
  const {
    mode,
    images,
    parentId,
    readDate,
    readTime,
    inFlight,
    elapsedMs,
    response,
    error,
    setMode,
    setParentId,
    setReadDate,
    setReadTime,
    setImage,
    submit,
    reset,
  } = usePeriscopeChat();
  const readDateInputId = useId();
  const readTimeInputId = useId();

  // Listen for "Debrief this" clicks from the history panel. The
  // event carries a parentId; we flip mode + prefill parentId so the
  // user just has to drop screenshots and submit. Skipped if a
  // submission is in flight (don't yank state out from under it).
  useEffect(() => {
    function onStartDebrief(e: Event) {
      const detail = (e as CustomEvent<DebriefEventDetail>).detail;
      if (!detail || typeof detail.parentId !== 'number') return;
      if (inFlight) return;
      setMode('debrief');
      setParentId(detail.parentId);
    }
    window.addEventListener(PERISCOPE_DEBRIEF_EVENT, onStartDebrief);
    return () =>
      window.removeEventListener(PERISCOPE_DEBRIEF_EVENT, onStartDebrief);
  }, [inFlight, setMode, setParentId]);

  const stagedCount = Object.values(images).filter((v) => v != null).length;
  const canSubmit = !inFlight && stagedCount > 0;

  const elapsedLabel =
    elapsedMs > 0 ? ` · ${Math.floor(elapsedMs / 1000)}s elapsed` : '';

  const modeBadge =
    response == null
      ? null
      : (MODE_OPTIONS.find((m) => m.value === response.mode)?.label ??
        response.mode);

  return (
    <SectionBox
      label="Periscope Chat"
      badge={
        response
          ? `${modeBadge} · ${Math.round(response.durationMs / 1000)}s`
          : null
      }
      collapsible
      defaultCollapsed={false}
    >
      <div className="flex flex-col gap-4">
        {/* Mode toggle */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">Mode:</span>
          <div
            className="border-edge bg-surface/60 inline-flex rounded-md border p-0.5"
            role="radiogroup"
            aria-label="Analysis mode"
          >
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={mode === opt.value}
                onClick={() => setMode(opt.value)}
                disabled={inFlight}
                className={`rounded px-3 py-1 text-xs font-medium tracking-wide uppercase transition ${
                  mode === opt.value
                    ? 'bg-[var(--color-accent)] text-white shadow-sm'
                    : 'text-secondary hover:text-primary'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {(mode === 'intraday' || mode === 'debrief') && parentId != null && (
            <span className="text-muted ml-2 font-mono text-[10px]">
              Linked to read #{parentId}
            </span>
          )}

          {/* Read date + time pickers — anchor the read against the SPX
              candle the backend looks up from index_candles_1m. */}
          <div className="ml-auto flex items-center gap-2">
            <label
              htmlFor={readDateInputId}
              className="text-muted text-xs"
              title="The trading date the read is FOR (CT)"
            >
              Read date:
            </label>
            <input
              id={readDateInputId}
              type="date"
              value={readDate}
              onChange={(e) => setReadDate(e.target.value)}
              disabled={inFlight}
              className="border-edge bg-surface/60 text-secondary rounded-md border px-2 py-0.5 text-xs disabled:opacity-40"
              aria-label="Read date (YYYY-MM-DD)"
            />
            <label
              htmlFor={readTimeInputId}
              className="text-muted ml-2 text-xs"
              title="HH:MM (24h CT) — 10-min granularity"
            >
              Time:
            </label>
            <select
              id={readTimeInputId}
              value={readTime}
              onChange={(e) => setReadTime(e.target.value)}
              disabled={inFlight}
              className="border-edge bg-surface/60 text-secondary rounded-md border px-2 py-0.5 text-xs disabled:opacity-40"
              aria-label="Read time (HH:MM CT)"
            >
              {TIME_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Image upload slots */}
        <div className="flex flex-col gap-2">
          <p className="text-muted text-xs">
            Drop, click, or paste (Ctrl+V) screenshots — pasted images fill
            chart → GEX → charm in order.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {PERISCOPE_IMAGE_KINDS.map(({ kind, label, hint }) => (
              <ImageSlot
                key={kind}
                label={label}
                hint={hint}
                preview={images[kind]?.preview ?? null}
                disabled={inFlight}
                onSelect={(file) => setImage(kind, file)}
              />
            ))}
          </div>
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {inFlight
              ? `Analyzing${elapsedLabel}…`
              : mode === 'debrief'
                ? 'Submit debrief'
                : mode === 'pre_trade'
                  ? 'Submit pre-trade'
                  : 'Submit intraday'}
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={inFlight}
            className="border-edge text-secondary hover:text-primary rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-40"
          >
            Reset
          </button>
          <span className="text-muted ml-auto text-xs">
            {stagedCount}/3 image{stagedCount === 1 ? '' : 's'} staged
          </span>
        </div>

        {/* Error */}
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-950/30 p-2 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {/* Response */}
        {response && (
          <div className="flex flex-col gap-3">
            <StructuredFieldsView fields={response.structured} />
            <PlaybookView fields={response.structured} />
            {response.parseOk === false && (
              <div
                role="status"
                className="rounded-md border border-amber-700/60 bg-amber-950/30 p-2 text-xs text-amber-300"
              >
                JSON playbook block was missing or malformed — structured fields
                may be partial. Prose is unaffected.
              </div>
            )}
            <p className="text-muted text-[10px]">
              Spot at read time: {response.spotAtReadTime.toFixed(2)} (
              {response.spotSource})
            </p>
            <ProseView prose={response.prose} />
          </div>
        )}
      </div>
    </SectionBox>
  );
}
