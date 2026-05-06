/**
 * History panel for past Periscope reads + debriefs.
 *
 * Mirrors the orchestrator pattern in
 * src/components/ChartAnalysis/AnalysisHistory.tsx:
 *
 *   1. Mode filter tabs at the top (All / Pre-Trade / Mid-Day / Review)
 *   2. Date dropdown — driven by /api/periscope-chat-list?dates=true
 *      (distinct trading_dates with per-mode counts). Always visible;
 *      defaults to "Select a date..." sentinel.
 *   3. List of rows for the selected (date, mode) pair, fetched via
 *      /api/periscope-chat-list?date=YYYY-MM-DD
 *   4. Click a row to expand its full detail inline
 *
 * State is kept in this component; the row card is an inline render
 * in this file (small enough that splitting would cost more than it
 * saves). All annotation updates from the detail view (stars / regime)
 * flow back through onAnnotated so the row reflects new state without
 * a refetch.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionBox } from '../ui/SectionBox';
import PeriscopeChatDetail from './PeriscopeChatDetail.js';
import { fmtTradingDate } from './format-utils.js';
import { theme } from '../../themes';
import { tint } from '../../utils/ui-utils.js';

// ============================================================
// Types
// ============================================================

type PeriscopeRowMode = 'pre_trade' | 'intraday' | 'debrief';

interface PeriscopeChatSummary {
  id: number;
  trading_date: string;
  captured_at: string;
  mode: PeriscopeRowMode;
  parent_id: number | null;
  spot: number | null;
  long_trigger: number | null;
  short_trigger: number | null;
  regime_tag: string | null;
  calibration_quality: number | null;
  prose_excerpt: string;
  duration_ms: number | null;
}

interface DateEntry {
  date: string; // YYYY-MM-DD
  total: number;
  /** Aggregate of pre_trades + intradays. Server-computed for back-compat. */
  reads: number;
  pre_trades?: number;
  intradays?: number;
  debriefs: number;
}

type ModeFilter = 'all' | 'pre_trade' | 'intraday' | 'debrief';

// ============================================================
// Formatters & style maps
// ============================================================

function fmtNum(n: number | null): string {
  return n == null
    ? '—'
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** "3h ago" / "5m ago" — relative capture time, falls back to mm-dd. */
function fmtRelative(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diffMs = Date.now() - t;
    if (diffMs < 0) {
      // Future timestamps: fall through to absolute date label rather
      // than reporting "just now" for everything ahead of now (the
      // negative-diff `min` would otherwise satisfy `min < 1`).
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    }
    const min = Math.floor(diffMs / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtDuration(ms: number | null): string | null {
  if (ms == null || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** "Thu, Apr 30, 2026" — full label for the date dropdown options. */
function fmtDateOption(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return iso;
  }
}

const REGIME_STYLES: Record<string, string> = {
  pin: 'bg-blue-900/40 text-blue-300',
  'drift-and-cap': 'bg-emerald-900/40 text-emerald-300',
  'gap-and-rip': 'bg-amber-900/40 text-amber-300',
  trap: 'bg-red-900/40 text-red-300',
  'cone-breach': 'bg-purple-900/40 text-purple-300',
  chop: 'bg-slate-800/60 text-slate-300',
  other: 'bg-slate-800/60 text-slate-300',
};

function regimeStyle(tag: string | null): string {
  if (!tag) return 'bg-slate-800/60 text-slate-300';
  return REGIME_STYLES[tag] ?? 'bg-slate-800/60 text-slate-300';
}

function modeTint(mode: PeriscopeRowMode): string {
  if (mode === 'debrief') return 'border-purple-900/40 bg-purple-950/10';
  if (mode === 'pre_trade') return 'border-sky-900/30 bg-sky-950/10';
  return 'border-emerald-900/30 bg-emerald-950/10';
}

const MODE_TABS: Array<{ key: ModeFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pre_trade', label: 'Pre-Trade' },
  { key: 'intraday', label: 'Mid-Day' },
  { key: 'debrief', label: 'Review' },
];

/** Per-mode color used for active tab tinting. Mirrors `modeTint()` rows. */
function modeTabColor(mode: ModeFilter): string {
  if (mode === 'pre_trade') return '#38BDF8'; // sky-400 — matches the sky-tinted row strip
  if (mode === 'intraday') return '#34D399'; // emerald-400
  if (mode === 'debrief') return '#A78BFA';
  return theme.text;
}

/** Per-mode count for a given DateEntry. Used in the date dropdown options. */
function dateCount(d: DateEntry, filter: ModeFilter): number {
  if (filter === 'pre_trade') return d.pre_trades ?? 0;
  if (filter === 'intraday') return d.intradays ?? 0;
  if (filter === 'debrief') return d.debriefs;
  return d.total;
}

// ============================================================
// Component
// ============================================================

export default function PeriscopeChatHistory() {
  const [dates, setDates] = useState<DateEntry[]>([]);
  const [datesError, setDatesError] = useState<string | null>(null);
  // Bumped by the `periscope:submitted` window event so the dates
  // aggregation + selected-date rows re-fetch after a fresh submission
  // by the sibling submit panel. Without this the dropdown counts
  // grow stale (intraday read saved → DB row exists → panel still
  // shows yesterday's count until manual page reload).
  const [refreshTick, setRefreshTick] = useState(0);
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [items, setItems] = useState<PeriscopeChatSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRowId, setOpenRowId] = useState<number | null>(null);
  const [annotationOverrides, setAnnotationOverrides] = useState<
    Record<
      number,
      { calibration_quality: number | null; regime_tag: string | null }
    >
  >({});

  // Re-fetch dates + rows when the submit panel publishes a new row.
  useEffect(() => {
    const handler = () => setRefreshTick((t) => t + 1);
    window.addEventListener('periscope:submitted', handler);
    return () => window.removeEventListener('periscope:submitted', handler);
  }, []);

  // Fetch the date list on mount + after every successful submission.
  // The picker dropdown shows every distinct trading_date with counts
  // per mode, kept fresh via the `refreshTick` dep.
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        // Cache-bust on refresh so the 30s s-maxage on
        // /api/periscope-chat-list?dates=true doesn't echo a stale
        // pre-submission count back to us.
        const url =
          refreshTick === 0
            ? '/api/periscope-chat-list?dates=true'
            : `/api/periscope-chat-list?dates=true&_=${refreshTick}`;
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          if (!ac.signal.aborted) setDatesError('Failed to load dates');
          return;
        }
        const data = (await res.json()) as { dates: DateEntry[] };
        if (ac.signal.aborted) return;
        setDates(data.dates);
        // Date is left unselected by default — the dropdown shows
        // "Select a date..." and the user picks. Mirrors the analysis-
        // history pattern so both panels behave the same.
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setDatesError('Failed to load dates');
      }
    })();
    return () => ac.abort();
  }, [refreshTick]);

  // Fetch rows for the selected date.
  useEffect(() => {
    if (!selectedDate) {
      setItems([]);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // Cache-bust on refresh — same reason as the dates query.
        const baseUrl = `/api/periscope-chat-list?date=${selectedDate}&limit=100`;
        const url = refreshTick === 0 ? baseUrl : `${baseUrl}&_=${refreshTick}`;
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { items: PeriscopeChatSummary[] };
        if (ac.signal.aborted) return;
        setItems(data.items);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [selectedDate, refreshTick]);

  const handleAnnotated = useCallback(
    (
      rowId: number,
      next: { calibration_quality: number | null; regime_tag: string | null },
    ) => {
      setAnnotationOverrides((prev) => ({ ...prev, [rowId]: next }));
    },
    [],
  );

  // Apply mode filter + annotation overrides to the fetched rows.
  // Mode keys map directly to row.mode now ('all' shows everything,
  // 'pre_trade' / 'intraday' / 'debrief' filter to that exact mode).
  const filtered = useMemo(() => {
    return items
      .filter((it) => {
        if (modeFilter === 'all') return true;
        return it.mode === modeFilter;
      })
      .map((it) => {
        const o = annotationOverrides[it.id];
        return o ? { ...it, ...o } : it;
      });
  }, [items, modeFilter, annotationOverrides]);

  const filteredCount = filtered.length;
  const totalCount = items.length;

  return (
    <SectionBox
      label="Periscope History"
      badge={dates.length > 0 ? `${dates.length} days` : null}
      collapsible
      defaultCollapsed={true}
    >
      <div className="flex flex-col gap-3">
        {/* Mode filter tabs — visual parity with AnalysisHistoryPicker */}
        <div className="flex flex-wrap gap-1.5">
          {MODE_TABS.map(({ key, label }) => {
            const active = modeFilter === key;
            const color = modeTabColor(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => setModeFilter(key)}
                className="cursor-pointer rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold transition-all duration-100"
                style={{
                  backgroundColor: active ? tint(color, '15') : 'transparent',
                  color: active ? color : theme.textMuted,
                  border: `1.5px solid ${active ? color + '40' : theme.border}`,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {datesError && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-950/30 p-2 text-xs text-red-300"
          >
            {datesError}
          </div>
        )}

        {/* Date dropdown — always visible; matches AnalysisHistoryPicker */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label
              htmlFor="periscope-date-picker"
              className="text-muted mb-1 block font-sans text-[9px] font-bold tracking-wider uppercase"
            >
              Date
            </label>
            <select
              id="periscope-date-picker"
              value={selectedDate}
              onChange={(e) => {
                setSelectedDate(e.target.value);
                setOpenRowId(null);
              }}
              className="bg-input border-edge-strong hover:border-edge-heavy w-full cursor-pointer appearance-none rounded-lg border-[1.5px] px-3 py-2 font-mono text-[12px] transition-[border-color] duration-150 outline-none"
              style={{ color: theme.text }}
            >
              <option value="">Select a date...</option>
              {dates.map((d) => {
                const count = dateCount(d, modeFilter);
                return (
                  <option key={d.date} value={d.date}>
                    {fmtDateOption(d.date)} ({count})
                  </option>
                );
              })}
            </select>
          </div>
          {selectedDate && (
            <div className="text-muted text-[10px]">
              {totalCount > 0 && filteredCount !== totalCount ? (
                <span>
                  showing {filteredCount} of {totalCount}
                </span>
              ) : (
                <span>{totalCount} rows</span>
              )}
            </div>
          )}
        </div>

        {/* Empty state — no history at all */}
        {dates.length === 0 && !datesError && (
          <p className="text-muted text-xs">
            No saved analyses yet. Submit a read or debrief above to start
            building history.
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-700/60 bg-red-950/30 p-2 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {loading && <p className="text-muted text-xs">Loading…</p>}

        {/* Empty state — selected date has no rows for the active filter */}
        {!loading &&
          selectedDate &&
          dates.length > 0 &&
          filtered.length === 0 && (
            <p className="text-muted text-xs">
              No{' '}
              {modeFilter === 'all'
                ? 'rows'
                : modeFilter === 'pre_trade'
                  ? 'pre-trade reads'
                  : modeFilter === 'intraday'
                    ? 'intraday reads'
                    : 'debriefs'}{' '}
              for {fmtTradingDate(selectedDate)}.
            </p>
          )}

        {/* Row list */}
        <ul className="flex flex-col gap-2">
          {filtered.map((item) => (
            <li
              key={item.id}
              className={`overflow-hidden rounded-lg border ${modeTint(item.mode)}`}
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() =>
                    setOpenRowId((prev) => (prev === item.id ? null : item.id))
                  }
                  aria-expanded={openRowId === item.id}
                  className="hover:bg-surface/30 flex flex-1 flex-col gap-1.5 p-3 text-left transition focus:ring-1 focus:ring-[var(--color-accent)] focus:outline-none"
                >
                  {/* Row 1 — identity + spot */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase ${
                        item.mode === 'debrief'
                          ? 'bg-purple-900/50 text-purple-200'
                          : item.mode === 'pre_trade'
                            ? 'bg-sky-900/50 text-sky-200'
                            : 'bg-emerald-900/50 text-emerald-200'
                      }`}
                    >
                      {item.mode === 'pre_trade' ? 'pre-trade' : item.mode}
                    </span>
                    <span className="text-primary font-mono text-xs font-semibold">
                      {fmtTradingDate(item.trading_date)}
                    </span>
                    {item.regime_tag && (
                      <span
                        className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${regimeStyle(item.regime_tag)}`}
                      >
                        {item.regime_tag}
                      </span>
                    )}
                    {item.calibration_quality != null &&
                      item.calibration_quality > 0 && (
                        <span
                          className="text-yellow-400"
                          title={`${item.calibration_quality}/5 stars`}
                        >
                          {'★'.repeat(item.calibration_quality)}
                        </span>
                      )}
                    <span className="text-muted ml-auto flex items-baseline gap-1.5 font-mono text-xs">
                      <span className="text-[10px] uppercase">spot</span>
                      <span className="text-primary text-sm font-semibold">
                        {fmtNum(item.spot)}
                      </span>
                    </span>
                  </div>

                  {/* Row 2 — triggers + linkage + meta */}
                  <div className="text-muted flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px]">
                    {item.long_trigger != null && (
                      <span>
                        <span className="text-emerald-400">▲</span> long{' '}
                        <span className="text-secondary">
                          {fmtNum(item.long_trigger)}
                        </span>
                      </span>
                    )}
                    {item.short_trigger != null && (
                      <span>
                        <span className="text-red-400">▼</span> short{' '}
                        <span className="text-secondary">
                          {fmtNum(item.short_trigger)}
                        </span>
                      </span>
                    )}
                    {item.parent_id != null && (
                      <span className="text-purple-300">
                        ↳{' '}
                        {item.mode === 'debrief'
                          ? `debrief of #${item.parent_id}`
                          : `chained from #${item.parent_id}`}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-2">
                      {fmtDuration(item.duration_ms) && (
                        <span>{fmtDuration(item.duration_ms)}</span>
                      )}
                      <span>{fmtRelative(item.captured_at)}</span>
                      <span className="text-[9px] opacity-60">#{item.id}</span>
                    </span>
                  </div>

                  {/* Row 3 — prose excerpt */}
                  {item.prose_excerpt && (
                    <p className="text-secondary line-clamp-3 text-xs leading-relaxed">
                      {item.prose_excerpt}
                    </p>
                  )}
                </button>
              </div>

              {openRowId === item.id && (
                <div className="border-edge border-t p-2">
                  <PeriscopeChatDetail
                    rowId={item.id}
                    onClose={() => setOpenRowId(null)}
                    onSelectParent={(parentId) => setOpenRowId(parentId)}
                    onAnnotated={handleAnnotated}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </SectionBox>
  );
}
